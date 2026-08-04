/*
 * page-hook.js — runs in the page's MAIN world.
 *
 * The caption URLs in ytInitialPlayerResponse are missing YouTube's `pot`
 * (proof-of-origin) token, so requesting one directly returns an empty 200.
 * Only the player's own request carries a usable token, so we watch for it.
 *
 * Three ways in, because any one of them can miss:
 *   1. patched fetch / XHR    — catches requests made after we install
 *   2. PerformanceObserver    — catches everything else, including requests
 *                               issued before this script ran
 *   3. toggling a track on    — forces a request when none has happened yet
 */
(() => {
  const CHANNEL = 'yps';
  const TIMEDTEXT = '/api/timedtext';
  // Bumped whenever the message shape changes. Reloading the add-on leaves the
  // previous hook installed in any page already open — it keeps answering, and
  // answers faster than this one, so its replies must be identifiable and
  // ignorable. Every message we send carries this.
  const PROTO = 3;

  // A hook of this version or newer is already live in this page.
  if (window.__ypsHookProto >= PROTO) return;
  window.__ypsHookProto = PROTO;

  // { url, videoId } — videoId guards against reusing the previous video's URL.
  let captured = null;
  const waiting = new Set();

  /** Rewrite a caption URL to ask for the parseable json3 format. */
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

  function remember(raw) {
    const url = asJson3(raw);
    if (!url || url === captured?.url) return;

    let videoId = null;
    try {
      videoId = new URL(url).searchParams.get('v');
    } catch {
      /* keep videoId null and treat the URL as unattributed */
    }
    captured = { url, videoId };

    for (const resolve of waiting) resolve(url);
    waiting.clear();

    // Tell the content script straight away — it may be sitting on a video it
    // could not resolve, and this is the signal that it can try again.
    window.postMessage(
      { channel: CHANNEL, proto: PROTO, type: 'CAPTION_SEEN', url, videoId },
      location.origin
    );
  }

  /* ----------------------------------------------------- request watching */

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

  // Resource timing sees requests the patches above cannot: ones issued before
  // this script ran, or through a fetch reference captured ahead of us.
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.includes(TIMEDTEXT)) remember(entry.name);
      }
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    /* older engines: the patches above still cover the common case */
  }

  /* ------------------------------------------------------------- helpers */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Resolve as soon as a caption URL turns up, or null once `ms` elapses. */
  const nextCaptionUrl = (ms) =>
    new Promise((resolve) => {
      if (captured) return resolve(captured.url);
      waiting.add(resolve);
      setTimeout(() => {
        waiting.delete(resolve);
        resolve(captured?.url || null);
      }, ms);
    });

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
   * Prefer a human-authored track over speech recognition, and English over
   * anything else — models translate out of English most reliably.
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

  /* ------------------------------------------------------------- resolve */

  /** We draw our own overlay, so the player's captions must not double it. */
  function silenceNativeCaptions(player) {
    try {
      player.setOption('captions', 'track', {});
    } catch {
      /* the content script also hides them via CSS, so this is best-effort */
    }
  }

  async function resolveCaptions(player, wantVideoId) {
    // A captured URL is only good for the video it belongs to.
    const usable = () =>
      captured && (!wantVideoId || !captured.videoId || captured.videoId === wantVideoId)
        ? captured.url
        : null;

    // Already have one, so skip the track toggle and avoid flickering the
    // native captions — but still switch them off, since having a URL usually
    // means they are on right now and would double our overlay.
    const existing = usable();
    if (existing) {
      silenceNativeCaptions(player);
      return { url: existing, track: null, tracklist: [], reused: true };
    }

    const tracklist = await captionTracklist(player);
    const track = preferredTrack(tracklist);
    if (!track) return { url: usable(), track: null, tracklist };

    // Clear so nextCaptionUrl waits for this video's request, not a stale one.
    captured = null;
    let url = null;
    try {
      player.setOption('captions', 'track', track); // forces the player to fetch
      url = await nextCaptionUrl(6000);
    } catch {
      /* the player rejected the track; fall back to whatever we captured */
    }
    silenceNativeCaptions(player);
    return { url: url || usable(), track, tracklist };
  }

  /* ------------------------------------------------------------ protocol */

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.channel !== CHANNEL || msg.type !== 'REQ_CAPTIONS') return;

    const reply = (payload) =>
      window.postMessage(
        { channel: CHANNEL, proto: PROTO, type: 'RES_CAPTIONS', id: msg.id, ...payload },
        location.origin
      );

    const player = document.getElementById('movie_player');
    const response = playerResponse(player);
    const videoId =
      msg.videoId ||
      response?.videoDetails?.videoId ||
      new URLSearchParams(location.search).get('v');

    // Subject-matter context for the translator. A gaming video's "troops" and
    // "raid" mean something specific, and the model can only know that if we
    // tell it what the video is.
    const details = response?.videoDetails || {};
    const meta = {
      title: details.title || null,
      author: details.author || null,
      description: (details.shortDescription || '').slice(0, 1000) || null,
      keywords: Array.isArray(details.keywords) ? details.keywords.slice(0, 12) : [],
    };

    // Only a hint: this is empty on plenty of videos that do have tracks, so it
    // must never be what decides there are no subtitles.
    const listed =
      response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    if (!player) {
      reply({
        videoId,
        url: null,
        sourceLang: null,
        meta,
        hasCaptions: listed.length > 0,
        diag: { player: false, listed: listed.length, tracklist: 0 },
      });
      return;
    }

    const { url, track, tracklist, reused } = await resolveCaptions(player, videoId);
    reply({
      videoId,
      url,
      sourceLang: track?.languageCode || null,
      meta,
      hasCaptions: Boolean(url) || tracklist.length > 0 || listed.length > 0,
      diag: {
        player: true,
        listed: listed.length,
        tracklist: tracklist.length,
        captured: Boolean(url),
        reused: Boolean(reused),
      },
    });
  });

  window.postMessage(
    { channel: CHANNEL, proto: PROTO, type: 'HOOK_READY' },
    location.origin
  );
})();
