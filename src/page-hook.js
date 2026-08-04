/*
 * page-hook.js — runs in the page's MAIN world.
 *
 * The caption URLs listed in ytInitialPlayerResponse are missing the `pot`
 * (proof-of-origin) token, so fetching them directly returns an empty 200.
 * Only YouTube's own player issues a request carrying a usable token.
 *
 * So we shadow fetch/XHR, watch for the player's own /api/timedtext request,
 * and keep the URL. To make that request happen on demand we briefly switch a
 * caption track on, grab the URL, then switch it back off — our overlay does
 * the rendering, so the native captions must not stay visible.
 */
(() => {
  const CHANNEL = 'yps';
  const TIMEDTEXT = '/api/timedtext';

  let capturedUrl = null;
  const pending = new Set();

  /** Rewrite a captured caption URL to ask for the parseable json3 format. */
  const asJson3 = (raw) => {
    try {
      const url = new URL(raw, location.origin);
      if (!url.pathname.includes(TIMEDTEXT)) return null;
      url.searchParams.set('fmt', 'json3');
      return url.toString();
    } catch {
      return null;
    }
  };

  const remember = (raw) => {
    const url = asJson3(raw);
    if (!url) return;
    capturedUrl = url;
    for (const resolve of pending) resolve(url);
    pending.clear();
  };

  const nativeFetch = window.fetch;
  window.fetch = function (resource, options) {
    try {
      const url = typeof resource === 'string' ? resource : resource?.url;
      if (url && String(url).includes(TIMEDTEXT)) remember(url);
    } catch {
      /* never let instrumentation break the player */
    }
    return nativeFetch.apply(this, arguments);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (url && String(url).includes(TIMEDTEXT)) remember(url);
    } catch {
      /* as above */
    }
    return nativeOpen.apply(this, arguments);
  };

  /** Resolve as soon as a caption URL is seen, or null once `ms` elapses. */
  const nextCaptionUrl = (ms) =>
    new Promise((resolve) => {
      if (capturedUrl) return resolve(capturedUrl);
      pending.add(resolve);
      setTimeout(() => {
        pending.delete(resolve);
        resolve(capturedUrl);
      }, ms);
    });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const playerResponse = (player) => {
    try {
      if (typeof player?.getPlayerResponse === 'function') {
        const response = player.getPlayerResponse();
        if (response) return response;
      }
    } catch {
      /* fall through to the bootstrap copy */
    }
    return window.ytInitialPlayerResponse || null;
  };

  /**
   * Prefer a human-authored track over auto-generated speech recognition, and
   * English over anything else — models translate from it most reliably.
   */
  const preferredTrack = (tracks) => {
    if (!tracks?.length) return null;
    const manual = (t) => t.kind !== 'asr';
    const english = (t) => (t.languageCode || '').startsWith('en');
    return (
      tracks.find((t) => manual(t) && english(t)) ||
      tracks.find(manual) ||
      tracks.find(english) ||
      tracks[0]
    );
  };

  async function captionTracklist(player) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const list = player.getOption('captions', 'tracklist');
        if (list?.length) return list;
      } catch {
        /* the captions module may not be loaded yet */
      }
      try {
        player.loadModule?.('captions');
      } catch {
        /* older players expose no loadModule */
      }
      await sleep(400);
    }
    return [];
  }

  async function resolveCaptions(player) {
    const tracklist = await captionTracklist(player);
    const track = preferredTrack(tracklist);
    if (!track) return { url: capturedUrl, track: null };

    // Drop any URL from a previous video so we wait for this one's request.
    capturedUrl = null;
    let url = null;
    try {
      player.setOption('captions', 'track', track);
      url = await nextCaptionUrl(6000);
    } catch {
      /* the player rejected the track; fall back to whatever we captured */
    }
    try {
      player.setOption('captions', 'track', {});
    } catch {
      /* leaving native captions on is survivable */
    }
    return { url: url || capturedUrl, track };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.channel !== CHANNEL || msg.type !== 'REQ_CAPTIONS') return;

    const reply = (payload) =>
      window.postMessage(
        { channel: CHANNEL, type: 'RES_CAPTIONS', id: msg.id, ...payload },
        location.origin
      );

    const player = document.getElementById('movie_player');
    const response = playerResponse(player);
    const videoId = response?.videoDetails?.videoId || null;
    const available =
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    if (!player || !available.length) {
      reply({ videoId, url: null, sourceLang: null, hasCaptions: false });
      return;
    }

    const { url, track } = await resolveCaptions(player);
    reply({
      videoId,
      url,
      sourceLang: track?.languageCode || null,
      hasCaptions: true,
    });
  });

  window.postMessage({ channel: CHANNEL, type: 'HOOK_READY' }, location.origin);
})();
