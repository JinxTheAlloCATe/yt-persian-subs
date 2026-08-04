/*
 * content.js — isolated world.
 *
 * Asks the page hook for a usable caption URL, pulls the transcript, hands
 * batches of cues to the background page for translation, and paints the
 * Persian result over the player in sync with playback.
 */
(() => {
  const CHANNEL = 'yps';
  const BATCH_SIZE = 35;
  // How far ahead of the playhead we keep translations warm, in batches.
  const PREFETCH = 1;

  const DEFAULTS = {
    enabled: true,
    fontSize: 26,
    model: 'google/gemini-2.0-flash-001',
    showOriginal: false,
  };

  let settings = { ...DEFAULTS };
  let session = null; // per-video state
  let overlay = null;
  let statusEl = null;
  let rafId = null;

  /* ---------------------------------------------------------------- utils */

  const log = (...args) => console.debug('[persian-subs]', ...args);

  const videoIdFromUrl = () => {
    try {
      return new URL(location.href).searchParams.get('v');
    } catch {
      return null;
    }
  };

  const playerEl = () => document.querySelector('.html5-video-player');
  const videoEl = () => document.querySelector('video.html5-main-video');

  /** Round-trip a request through the MAIN-world hook. */
  function askPage(type, timeout = 12000) {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const done = (value) => {
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(value);
      };
      const onMessage = (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (msg?.channel !== CHANNEL || msg.id !== id) return;
        done(msg);
      };
      const timer = setTimeout(() => done(null), timeout);
      window.addEventListener('message', onMessage);
      window.postMessage({ channel: CHANNEL, type, id }, location.origin);
    });
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'no response' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  /* ------------------------------------------------------------- overlay */

  function injectFontFace() {
    if (document.getElementById('yps-font')) return;
    const regular = chrome.runtime.getURL('fonts/Vazirmatn-Regular.woff2');
    const bold = chrome.runtime.getURL('fonts/Vazirmatn-Bold.woff2');
    const style = document.createElement('style');
    style.id = 'yps-font';
    style.textContent = `
      @font-face {
        font-family: 'Vazirmatn YPS';
        src: url('${regular}') format('woff2');
        font-weight: 400;
        font-display: swap;
      }
      @font-face {
        font-family: 'Vazirmatn YPS';
        src: url('${bold}') format('woff2');
        font-weight: 700;
        font-display: swap;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureOverlay() {
    const player = playerEl();
    if (!player) return null;
    if (overlay && overlay.parentElement === player) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'yps-overlay';
    overlay.dir = 'rtl';

    statusEl = document.createElement('div');
    statusEl.className = 'yps-status';
    overlay.appendChild(statusEl);

    const line = document.createElement('div');
    line.className = 'yps-line';
    overlay.appendChild(line);

    player.appendChild(overlay);
    applyFontSize();
    return overlay;
  }

  function applyFontSize() {
    if (!overlay) return;
    overlay.style.setProperty('--yps-size', `${settings.fontSize}px`);
  }

  function setStatus(text, tone = 'info') {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.dataset.tone = tone;
    statusEl.style.display = text ? 'inline-block' : 'none';
  }

  function paint(cue) {
    if (!overlay) return;
    const line = overlay.querySelector('.yps-line');
    if (!line) return;

    if (!cue) {
      line.style.display = 'none';
      line.replaceChildren();
      return;
    }

    const persian = cue.translated;
    const parts = [];
    if (persian) {
      const fa = document.createElement('div');
      fa.className = 'yps-fa';
      fa.textContent = persian;
      parts.push(fa);
    }
    if (settings.showOriginal || !persian) {
      const src = document.createElement('div');
      src.className = 'yps-src';
      src.dir = 'ltr';
      src.textContent = cue.text;
      parts.push(src);
    }
    line.replaceChildren(...parts);
    line.style.display = parts.length ? 'block' : 'none';
  }

  function teardownOverlay() {
    stopLoop();
    overlay?.remove();
    overlay = null;
    statusEl = null;
  }

  /* ------------------------------------------------------------ captions */

  /** Convert YouTube's json3 payload into flat cues with second-based timing. */
  function parseJson3(payload) {
    const events = payload?.events || [];
    const cues = [];
    for (const event of events) {
      if (!event.segs || event.tStartMs == null) continue;
      const text = event.segs
        .map((seg) => seg.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text === '\n') continue;
      const start = event.tStartMs / 1000;
      const dur = (event.dDurationMs ?? 4000) / 1000;
      cues.push({ start, end: start + dur, text, translated: null });
    }

    // Auto-generated tracks emit rolling duplicates; keep the last write wins
    // ordering but drop cues that repeat the previous line verbatim.
    const deduped = [];
    for (const cue of cues) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.text === cue.text) {
        prev.end = Math.max(prev.end, cue.end);
        continue;
      }
      // Clamp overlapping cues so only one shows at a time.
      if (prev && prev.end > cue.start) prev.end = cue.start;
      deduped.push(cue);
    }
    return deduped;
  }

  async function loadCaptions(videoId) {
    const info = await askPage('REQ_CAPTIONS');
    if (!info) return { error: 'The player did not respond.' };
    if (!info.hasCaptions) return { error: 'This video has no subtitles.' };
    if (!info.url) return { error: 'Could not read the subtitle track.' };
    if (info.videoId && info.videoId !== videoId) {
      return { error: 'Video changed while loading.' };
    }

    let payload;
    try {
      const res = await fetch(info.url, { credentials: 'include' });
      if (!res.ok) return { error: `Subtitle fetch failed (${res.status}).` };
      payload = await res.json();
    } catch (err) {
      return { error: `Subtitle fetch failed: ${err.message}` };
    }

    const cues = parseJson3(payload);
    if (!cues.length) return { error: 'The subtitle track was empty.' };
    return { cues, sourceLang: info.sourceLang };
  }

  /* --------------------------------------------------------- translation */

  function batchIndexFor(cueIndex) {
    return Math.floor(cueIndex / BATCH_SIZE);
  }

  async function requestBatch(batch) {
    if (!session || session.batches[batch] !== 'idle') return;
    const mine = session;
    mine.batches[batch] = 'pending';

    const start = batch * BATCH_SIZE;
    const slice = mine.cues.slice(start, start + BATCH_SIZE);
    if (!slice.length) {
      mine.batches[batch] = 'done';
      return;
    }

    const response = await sendToBackground({
      type: 'TRANSLATE',
      videoId: mine.videoId,
      batch,
      sourceLang: mine.sourceLang,
      lines: slice.map((cue) => cue.text),
    });

    // A navigation may have replaced the session while we awaited.
    if (session !== mine) return;

    if (!response.ok) {
      mine.batches[batch] = 'error';
      setStatus(response.error || 'Translation failed', 'error');
      log('batch failed', batch, response.error);
      return;
    }

    const lines = response.translations || [];
    for (let i = 0; i < slice.length; i++) {
      if (lines[i]) slice[i].translated = lines[i];
    }
    mine.batches[batch] = 'done';
    if (mine.batches.every((s) => s !== 'error')) setStatus('');
  }

  function ensureBatchesAround(cueIndex) {
    if (!session) return;
    const first = batchIndexFor(Math.max(0, cueIndex));
    for (let b = first; b <= first + PREFETCH; b++) {
      if (b < session.batches.length && session.batches[b] === 'idle') {
        requestBatch(b);
      }
    }
  }

  /* ------------------------------------------------------------- playback */

  /** Binary search for the cue covering time `t`. */
  function cueAt(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best < 0) return { index: 0, cue: null };
    const cue = cues[best];
    return { index: best, cue: t <= cue.end ? cue : null };
  }

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!session || !settings.enabled) return;
    const video = videoEl();
    if (!video) return;

    const { index, cue } = cueAt(session.cues, video.currentTime);
    ensureBatchesAround(index);

    // Repaint when the cue changes, or when a batch lands and fills in the
    // translation for a cue that is already on screen.
    if (cue !== session.shownCue || cue?.translated !== session.shownText) {
      session.shownCue = cue;
      session.shownText = cue?.translated ?? null;
      paint(cue);
    }
  }

  function startLoop() {
    if (rafId == null) rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /* -------------------------------------------------------------- session */

  /** The player mounts asynchronously, so poll briefly rather than giving up. */
  function waitForPlayer(timeout = 15000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeout;
      const poll = () => {
        if (playerEl() && videoEl()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 250);
      };
      poll();
    });
  }

  async function startSession(videoId) {
    session = { videoId, cues: [], batches: [], shownCue: null, shownText: null };
    const mine = session;

    injectFontFace();
    if (!(await waitForPlayer())) return;
    if (session !== mine) return;
    if (!ensureOverlay()) return;
    setStatus('در حال آماده‌سازی زیرنویس…');

    const result = await loadCaptions(videoId);
    if (session !== mine) return; // navigated away mid-load

    if (result.error) {
      setStatus(result.error, 'error');
      log(result.error);
      return;
    }

    session.cues = result.cues;
    session.sourceLang = result.sourceLang;
    session.batches = new Array(Math.ceil(result.cues.length / BATCH_SIZE)).fill(
      'idle'
    );
    setStatus('');
    startLoop();
    ensureBatchesAround(0);
    log(`loaded ${result.cues.length} cues (${result.sourceLang})`);
  }

  function endSession() {
    session = null;
    paint(null);
    setStatus('');
  }

  let currentVideoId = null;

  async function sync() {
    const videoId = videoIdFromUrl();

    if (!videoId || !settings.enabled) {
      if (currentVideoId !== null) {
        currentVideoId = null;
        endSession();
        teardownOverlay();
      }
      return;
    }

    if (videoId === currentVideoId && session) return;
    currentVideoId = videoId;
    endSession();
    await startSession(videoId);
  }

  /* ---------------------------------------------------------------- boot */

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    sync();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let needsRestart = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (!(key in DEFAULTS)) continue;
      settings[key] = newValue;
      if (key === 'enabled' || key === 'model') needsRestart = true;
    }
    applyFontSize();
    if (needsRestart) {
      currentVideoId = null;
      endSession();
      sync();
    } else if (session?.shownCue) {
      paint(session.shownCue);
    }
  });

  // YouTube is a single-page app; this fires on every in-app navigation.
  document.addEventListener('yt-navigate-finish', () => setTimeout(sync, 800));
  window.addEventListener('popstate', () => setTimeout(sync, 800));
})();
