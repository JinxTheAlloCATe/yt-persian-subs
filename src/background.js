/*
 * background.js — event page (Firefox) / service worker (Chrome).
 *
 * Owns the OpenRouter API key: content scripts never see it, and the network
 * call happens off the page so YouTube cannot observe it. Translates cues in
 * batches, caches results per video + model, and caps in-flight requests.
 */

const API_BASE = 'https://openrouter.ai/api/v1';
const MAX_CONCURRENT = 2;
const CACHE_LIMIT = 400;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const SYSTEM_PROMPT = [
  'You are a professional subtitle translator working into Persian (Farsi).',
  'You receive a numbered list of subtitle lines from one video, in order.',
  'Translate every line into natural, contemporary Persian.',
  'Rules:',
  '- Return exactly as many translations as you were given, in the same order.',
  '- Translate each line on its own. Never merge, split, reorder, or drop lines.',
  '- Use the surrounding lines only as context for meaning and pronouns.',
  '- Keep it spoken and idiomatic, not word-for-word. Subtitles must read fast.',
  '- Preserve proper nouns, acronyms, numbers, and units.',
  '- Do not add commentary, transliteration, or quotation marks of your own.',
  '- If a line is untranslatable filler (e.g. [Music]), return it unchanged.',
  'Respond with JSON only: {"lines": ["…", "…"]}',
].join('\n');

/* ------------------------------------------------------------- settings */

const settings = () =>
  new Promise((resolve) => {
    chrome.storage.sync.get(
      { apiKey: '', model: 'google/gemini-2.0-flash-001' },
      resolve
    );
  });

const localGet = (keys) =>
  new Promise((resolve) => chrome.storage.local.get(keys, resolve));

const localSet = (items) =>
  new Promise((resolve) => chrome.storage.local.set(items, resolve));

const localRemove = (keys) =>
  new Promise((resolve) => chrome.storage.local.remove(keys, resolve));

/* ---------------------------------------------------------------- cache */

const cacheKey = (videoId, model, batch) => `tr:${videoId}:${model}:${batch}`;

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
      try {
        resolve(await task());
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      } finally {
        active--;
        queue.shift()?.();
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

async function callOpenRouter(apiKey, model, payloadLines) {
  const numbered = payloadLines
    .map((line, i) => `${i + 1}. ${line}`)
    .join('\n');

  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Translate these ${payloadLines.length} subtitle lines into Persian.\n\n${numbered}`,
      },
    ],
  };

  let lastError = 'Request failed';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      await new Promise((r) => setTimeout(r, 700 * 2 ** (attempt - 1)));
    }

    let res;
    try {
      res = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'Persian Subtitles for YouTube',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = `Network error: ${err.message}`;
      continue;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 401) {
        return { ok: false, error: 'کلید API نامعتبر است.' };
      }
      if (res.status === 402) {
        return { ok: false, error: 'اعتبار OpenRouter کافی نیست.' };
      }
      lastError = `OpenRouter ${res.status}: ${detail.slice(0, 160)}`;
      if (!RETRY_STATUSES.has(res.status)) break;
      continue;
    }

    const data = await res.json().catch(() => null);
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

async function translateBatch({ videoId, batch, lines }) {
  const { apiKey, model } = await settings();
  if (!apiKey) {
    return { ok: false, error: 'کلید OpenRouter تنظیم نشده است.' };
  }

  const key = cacheKey(videoId, model, batch);
  const cached = await cacheRead(key);
  if (cached && cached.length === lines.length) {
    return { ok: true, translations: cached, videoId, batch, cached: true };
  }

  const result = await withSlot(() => callOpenRouter(apiKey, model, lines));
  if (!result.ok) return { ...result, videoId, batch };

  await cacheWrite(key, result.lines);
  return { ok: true, translations: result.lines, videoId, batch };
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

async function clearCache() {
  const { __index = [] } = await localGet(['__index']);
  if (__index.length) await localRemove(__index);
  await localSet({ __index: [] });
  return { ok: true, cleared: __index.length };
}

/* ------------------------------------------------------------- routing */

const handlers = {
  TRANSLATE: translateBatch,
  VERIFY_KEY: (msg) => verifyKey(msg.apiKey),
  CLEAR_CACHE: clearCache,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // response is asynchronous
});
