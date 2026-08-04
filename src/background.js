/*
 * background.js — event page (Firefox) / service worker (Chrome).
 *
 * Owns the OpenRouter API key: content scripts never see it, and the network
 * call happens off the page so YouTube cannot observe it. Translates cues in
 * batches, caches results per video + model, and caps in-flight requests.
 */

const API_BASE = 'https://openrouter.ai/api/v1';
const MAX_CONCURRENT = 3;
// Per attempt. Three attempts plus backoff stays inside the content script's
// 90s wait, so a batch always gets a real answer rather than a bare timeout.
const REQUEST_TIMEOUT = 25000;
// Hard ceiling on how long any single task may hold a concurrency slot.
const SLOT_BUDGET = 80000;
const CACHE_LIMIT = 400;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const SYSTEM_PROMPT = [
  'You are a professional subtitle translator working into Persian (Farsi).',
  'You receive a numbered list of subtitle lines from one video, in order.',
  'Translate every line into natural, contemporary Persian.',
  'Rules:',
  '- Return exactly as many translations as you were given, in the same order.',
  '- Translate each line on its own. Never merge, split, reorder, or drop lines.',
  '- Keep it spoken and idiomatic, not word-for-word. Subtitles must read fast.',
  '- Match the register of the speaker: casual speech stays casual in Persian.',
  '- Preserve proper nouns, acronyms, numbers, and units.',
  '- Keep domain terms consistent with how you already rendered them earlier.',
  '- Leave game, software, and brand terms in their known Persian form, or in',
  '  the original script when Persian speakers normally use it untranslated.',
  '- Do not add commentary, transliteration, or quotation marks of your own.',
  '- If a line is untranslatable filler (e.g. [Music]), return it unchanged.',
  'Respond with JSON only: {"lines": ["…", "…"]}',
].join('\n');

/**
 * Everything the model gets beyond the lines themselves: what the video is,
 * and what sits either side of this batch. Auto-generated captions carry no
 * speaker or topic information, so without this the model is translating
 * sentences with no idea what they are about.
 */
function buildContextBlock(context = {}) {
  const { title, author, description, keywords, before, after } = context;
  const parts = [];

  const about = [];
  if (title) about.push(`Title: ${title}`);
  if (author) about.push(`Channel: ${author}`);
  if (keywords?.length) about.push(`Topics: ${keywords.join(', ')}`);
  if (description) about.push(`Description: ${description.slice(0, 700)}`);
  if (about.length) {
    parts.push(
      'The subtitles come from this video. Use it to resolve jargon and ' +
        'ambiguous words — do not translate or mention it.\n' +
        about.join('\n')
    );
  }

  if (before?.length) {
    const pairs = before
      .map((pair) => `EN: ${pair.source}\nFA: ${pair.persian}`)
      .join('\n');
    parts.push(
      'Immediately preceding lines, already translated. Stay consistent with ' +
        'these choices. Do not translate them again.\n' + pairs
    );
  }

  if (after?.length) {
    parts.push(
      'Lines that follow this batch, for context only. Do not translate them.\n' +
        after.map((line) => `- ${line}`).join('\n')
    );
  }

  return parts.join('\n\n');
}

/* ------------------------------------------------------------- settings */

const DEFAULT_MODEL = 'google/gemini-3.6-flash';

const OPENROUTER_ORIGIN = 'https://openrouter.ai/*';

/*
 * Firefox treats manifest host_permissions as optional: unlike Chrome it does
 * not grant them at install, so the OpenRouter call is blocked until the user
 * says yes. Everything else keeps working — captions are fetched from the
 * content script on youtube.com, which is same-origin — so the add-on looks
 * fine right up until nothing gets translated.
 */
function hasOpenRouterAccess() {
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [OPENROUTER_ORIGIN] }, (granted) => {
        if (chrome.runtime.lastError) return resolve(true); // can't tell; try anyway
        resolve(Boolean(granted));
      });
    } catch {
      resolve(true);
    }
  });
}

const settings = () =>
  new Promise((resolve) => {
    chrome.storage.sync.get({ apiKey: '', model: DEFAULT_MODEL }, resolve);
  });

const localGet = (keys) =>
  new Promise((resolve) => chrome.storage.local.get(keys, resolve));

const localSet = (items) =>
  new Promise((resolve) => chrome.storage.local.set(items, resolve));

const localRemove = (keys) =>
  new Promise((resolve) => chrome.storage.local.remove(keys, resolve));

/* ---------------------------------------------------------------- cache */

// Bump when segmentation or the prompt changes: cached output from an older
// scheme is not interchangeable with what we would produce now.
const CACHE_SCHEMA = 2;

const cacheKey = (videoId, model, batch) =>
  `tr:${CACHE_SCHEMA}:${videoId}:${model}:${batch}`;

async function cacheRead(key) {
  const store = await localGet([key]);
  return store[key] || null;
}

async function cacheWrite(key, lines) {
  const { __index = [] } = await localGet(['__index']);
  const index = __index.filter((k) => k !== key);
  index.push(key);

  const overflow = index.length - CACHE_LIMIT;
  const evicted = overflow > 0 ? index.splice(0, overflow) : [];
  if (evicted.length) await localRemove(evicted);

  await localSet({ [key]: lines, __index: index });
}

/* ------------------------------------------------------------ throttling */

let active = 0;
const queue = [];

function withSlot(task) {
  return new Promise((resolve) => {
    const run = async () => {
      active++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        active--;
        queue.shift()?.();
      };

      // Belt and braces: a task that never settles would hold its slot for
      // good, and once every slot is held nothing else can ever run. The
      // deadline on the fetch itself should prevent that; this makes sure a
      // future stall somewhere else cannot jam the whole queue again.
      const watchdog = setTimeout(() => {
        resolve({ ok: false, error: 'درخواست بیش از حد طول کشید.' });
        release();
      }, SLOT_BUDGET);

      try {
        resolve(await task());
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      } finally {
        clearTimeout(watchdog);
        release();
      }
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

/* ------------------------------------------------------------- parsing */

/** Pull a JSON value out of a model response that may be fenced or chatty. */
function extractJson(text) {
  const trimmed = String(text || '').trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const candidates = [unfenced];
  const objStart = unfenced.indexOf('{');
  const objEnd = unfenced.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    candidates.push(unfenced.slice(objStart, objEnd + 1));
  }
  const arrStart = unfenced.indexOf('[');
  const arrEnd = unfenced.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    candidates.push(unfenced.slice(arrStart, arrEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next slice */
    }
  }
  return null;
}

function linesFromResponse(text, expected) {
  const parsed = extractJson(text);
  let lines = null;

  if (Array.isArray(parsed)) lines = parsed;
  else if (Array.isArray(parsed?.lines)) lines = parsed.lines;
  else if (Array.isArray(parsed?.translations)) lines = parsed.translations;

  if (!lines) {
    // Last resort: the model answered as a numbered plain-text list.
    const numbered = String(text || '')
      .split('\n')
      .map((line) => line.match(/^\s*\d+\s*[.):-]\s*(.+)$/))
      .filter(Boolean)
      .map((match) => match[1].trim());
    if (numbered.length) lines = numbered;
  }

  if (!lines) return null;

  const normalized = lines.map((line) =>
    typeof line === 'string' ? line.trim() : String(line ?? '').trim()
  );
  // Pad or trim so cue indexes always line up with the source batch.
  if (normalized.length > expected) normalized.length = expected;
  while (normalized.length < expected) normalized.push('');
  return normalized;
}

/* ------------------------------------------------------------ API calls */

async function callOpenRouter(apiKey, model, payloadLines, context) {
  const numbered = payloadLines
    .map((line, i) => `${i + 1}. ${line}`)
    .join('\n');

  const contextBlock = buildContextBlock(context);
  const instruction =
    `Translate these ${payloadLines.length} subtitle lines into Persian. ` +
    `Return ${payloadLines.length} translations.`;

  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: contextBlock
          ? `${contextBlock}\n\n---\n\n${instruction}\n\n${numbered}`
          : `${instruction}\n\n${numbered}`,
      },
    ],
  };

  let lastError = 'Request failed';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      await new Promise((r) => setTimeout(r, 700 * 2 ** (attempt - 1)));
    }

    /*
     * A fetch with no deadline can hang indefinitely, and because this runs
     * inside a concurrency slot a hung request never releases it. Two of those
     * and every later batch queues behind them forever — which surfaces as the
     * content script timing out with no error at all.
     */
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), REQUEST_TIMEOUT);

    let res;
    let payload = '';
    try {
      res = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Persian Subtitles for YouTube',
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      // Read the body under the same deadline; it can stall just as easily.
      payload = await res.text();
    } catch (err) {
      lastError =
        err?.name === 'AbortError'
          ? `مدل در ${REQUEST_TIMEOUT / 1000} ثانیه پاسخ نداد.`
          : `Network error: ${err.message}`;
      continue;
    } finally {
      clearTimeout(deadline);
    }

    if (!res.ok) {
      if (res.status === 401) {
        return { ok: false, error: 'کلید API نامعتبر است.' };
      }
      if (res.status === 402) {
        return { ok: false, error: 'اعتبار OpenRouter کافی نیست.' };
      }
      lastError = `OpenRouter ${res.status}: ${payload.slice(0, 160)}`;
      if (!RETRY_STATUSES.has(res.status)) break;
      continue;
    }

    let data = null;
    try {
      data = JSON.parse(payload);
    } catch {
      lastError = 'Malformed response from OpenRouter.';
      continue;
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      lastError = 'Empty response from the model.';
      continue;
    }

    const lines = linesFromResponse(content, payloadLines.length);
    if (!lines) {
      lastError = 'Could not parse the model response.';
      continue;
    }
    return { ok: true, lines };
  }

  return { ok: false, error: lastError };
}

// Persian and Arabic share this block; any real Persian line lands in it.
const PERSIAN = /[؀-ۿ]/;

function translationStats(lines) {
  const filled = lines.filter((line) => line.trim().length);
  const persian = filled.filter((line) => PERSIAN.test(line)).length;
  return {
    total: lines.length,
    filled: filled.length,
    persian,
    ratio: filled.length ? Number((persian / filled.length).toFixed(2)) : 0,
  };
}

/**
 * Returns an error message when a batch is not actually translated, or null
 * when it looks fine. Weak models tend to fail in two ways: they return
 * nothing parseable, or they echo the English straight back.
 */
function assessTranslation(lines) {
  const { total, filled, persian } = translationStats(lines);
  if (!filled) {
    return 'مدل هیچ ترجمه‌ای برنگرداند. مدل دیگری را امتحان کنید.';
  }
  if (persian / filled < 0.4) {
    return 'مدل به فارسی ترجمه نکرد. مدل دیگری را امتحان کنید.';
  }
  if (filled / total < 0.5) {
    return 'مدل بیشتر خط‌ها را ترجمه نکرد. مدل دیگری را امتحان کنید.';
  }
  return null;
}

async function translateBatch({ videoId, batch, lines, context }) {
  const { apiKey, model } = await settings();
  if (!apiKey) {
    return { ok: false, error: 'کلید OpenRouter تنظیم نشده است.' };
  }

  const key = cacheKey(videoId, model, batch);
  const cached = await cacheRead(key);
  if (cached && cached.length === lines.length) {
    // Builds before the Persian check wrote whatever came back, so a bad batch
    // cached then would be served for that video forever. Validate on read too,
    // and drop anything that no longer passes.
    const stale = assessTranslation(cached);
    if (!stale) {
      return {
        ok: true,
        translations: cached,
        videoId,
        batch,
        diag: { model, cached: true, ...translationStats(cached) },
      };
    }
    await localRemove([key]);
  }

  const result = await withSlot(() =>
    callOpenRouter(apiKey, model, lines, context)
  );
  if (!result.ok) return { ...result, videoId, batch };

  // The overlay falls back to the source line when a translation is missing,
  // which turns "the model ignored us" into subtitles that are silently still
  // in English. Catch that here instead of letting it look like it worked.
  const stats = translationStats(result.lines);
  const problem = assessTranslation(result.lines);
  if (problem) {
    return {
      ok: false,
      error: problem,
      videoId,
      batch,
      diag: { model, cached: false, ...stats },
    };
  }

  await cacheWrite(key, result.lines);
  return {
    ok: true,
    translations: result.lines,
    videoId,
    batch,
    diag: { model, cached: false, ...stats },
  };
}

/*
 * The catalogue moves — models get renamed and retired, and a hardcoded list
 * goes stale silently, surfacing as a "not found" error mid-video. So fetch it
 * live (this endpoint needs no key) and cache it for a day.
 */
const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;

async function listModels({ refresh } = {}) {
  const { __models } = await localGet(['__models']);
  if (!refresh && __models && Date.now() - __models.at < MODEL_CACHE_TTL) {
    return { ok: true, models: __models.models, cached: true };
  }

  try {
    const res = await fetch(`${API_BASE}/models`);
    if (!res.ok) return { ok: false, error: `OpenRouter ${res.status}` };
    const data = await res.json();

    const models = (data?.data || [])
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        // Pricing is per token; per-million is the unit people think in.
        prompt: Number(model.pricing?.prompt || 0) * 1e6,
        completion: Number(model.pricing?.completion || 0) * 1e6,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    if (!models.length) return { ok: false, error: 'Empty model list.' };
    await localSet({ __models: { at: Date.now(), models } });
    return { ok: true, models };
  } catch (err) {
    // Serve a stale list rather than nothing.
    if (__models) return { ok: true, models: __models.models, stale: true };
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

async function verifyKey(apiKey) {
  if (!apiKey) return { ok: false, error: 'No key provided.' };
  try {
    const res = await fetch(`${API_BASE}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) return { ok: false, error: 'Key rejected.' };
    if (!res.ok) return { ok: false, error: `OpenRouter ${res.status}` };
    const data = await res.json().catch(() => null);
    const info = data?.data || {};
    return {
      ok: true,
      label: info.label || null,
      usage: info.usage ?? null,
      limit: info.limit ?? null,
      isFree: info.is_free_tier ?? null,
    };
  } catch (err) {
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

/*
 * One real translation call, reported in full. Every failure mode so far has
 * looked identical from the outside — English subtitles — so this exists to
 * say which one it actually is, without reading a console.
 */
async function testTranslate() {
  const { apiKey, model } = await settings();
  if (!apiKey) return { ok: false, stage: 'key', error: 'No API key saved.' };

  const sample = [
    'You used to be able to sell buildings back in 2012.',
    'This is the biggest update the game has had in years.',
  ];

  let response;
  try {
    response = await callOpenRouter(apiKey, model, sample, {
      title: 'Test video',
      author: 'Test channel',
    });
  } catch (err) {
    response = { ok: false, error: String(err?.message || err) };
  }

  if (!response.ok) {
    // A blocked cross-origin request surfaces as an opaque network failure,
    // so name the likely cause rather than echoing "NetworkError".
    const blocked = /network|fetch|failed/i.test(response.error || '');
    const granted = await hasOpenRouterAccess();
    return {
      ok: false,
      stage: 'request',
      error: response.error,
      model,
      granted,
      hint:
        blocked && !granted
          ? 'openrouter.ai access is not granted — allow it in about:addons → Permissions.'
          : null,
    };
  }

  const stats = translationStats(response.lines);
  const problem = assessTranslation(response.lines);
  return {
    ok: !problem,
    stage: problem ? 'output' : 'done',
    model,
    error: problem || null,
    sample: response.lines[0] || '(empty)',
    stats,
  };
}

async function clearCache() {
  const { __index = [] } = await localGet(['__index']);
  if (__index.length) await localRemove(__index);
  await localSet({ __index: [] });
  return { ok: true, cleared: __index.length };
}

/* ------------------------------------------------------------- routing */

const handlers = {
  // Answering keeps the event page's idle timer from expiring while a slow
  // model is still working; see startHeartbeat in content.js.
  PING: async () => ({ ok: true }),
  TRANSLATE: translateBatch,
  VERIFY_KEY: (msg) => verifyKey(msg.apiKey),
  LIST_MODELS: (msg) => listModels({ refresh: msg.refresh }),
  CHECK_ACCESS: async () => ({ ok: true, granted: await hasOpenRouterAccess() }),
  TEST_TRANSLATE: testTranslate,
  CLEAR_CACHE: clearCache,
};

/*
 * Models that shipped as defaults but do not exist on OpenRouter. A stored
 * setting survives an update, so without this the add-on keeps failing with
 * "model not found" until the user notices and edits it by hand.
 */
const RETIRED_MODELS = new Set([
  'google/gemini-2.0-flash-001',
  'anthropic/claude-haiku-4-5',
]);

chrome.storage.sync.get({ model: DEFAULT_MODEL }, ({ model }) => {
  if (RETIRED_MODELS.has(model)) {
    chrome.storage.sync.set({ model: DEFAULT_MODEL });
  }
});

/*
 * Content scripts talk over a port rather than one-shot messages: an open
 * connection keeps this event page alive while a translation is in flight.
 * Without it Firefox can suspend the page mid-request and the reply is lost.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'yps') return;

  port.onMessage.addListener(async (message) => {
    const reply = (payload) => {
      try {
        port.postMessage({ ...payload, __id: message?.__id });
      } catch {
        // The page navigated away mid-request; nothing to deliver to.
      }
    };

    const handler = handlers[message?.type];
    if (!handler) {
      reply({ ok: false, error: `unknown request: ${message?.type}` });
      return;
    }
    try {
      reply(await handler(message));
    } catch (err) {
      reply({ ok: false, error: String(err?.message || err) });
    }
  });
});

// The popup is an extension page and is not subject to the same suspension
// problem, so it keeps using one-shot messages.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // response is asynchronous
});
