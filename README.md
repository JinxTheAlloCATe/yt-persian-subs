# Persian Subtitles for YouTube

Translates a YouTube video's subtitles into Persian with an OpenRouter model and
renders them over the player in real time.

Built for Firefox-based browsers — **Zen**, Firefox, LibreWolf, Floorp — which
is where it differs from most extensions of this kind: the background script is
an event page rather than a Chrome service worker, and the add-on carries a
Gecko ID so `storage.sync` and signing both work.

---

## What it does

- Pulls the real subtitle track from the video (see [How it works](#how-it-works)).
- Sends the cues to OpenRouter in batches of 35, with the surrounding lines as
  context so pronouns and idioms survive the trip.
- Paints the Persian text over the video, right-to-left, in Vazirmatn.
- Caches every translated batch, so re-watching a video costs nothing.
- Optionally keeps the original line visible underneath.

Translations are keyed by video **and** model, so switching models re-translates
rather than serving a stale result.

## Install on Zen

Zen is built on Firefox *release*, which will not permanently install an
unsigned add-on — `xpinstall.signatures.required` is ignored there. So you have
two options.

### Temporary (30 seconds, resets when the browser restarts)

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…**
3. Pick the `manifest.json` in this folder

### Permanent (self-sign, free)

Sign it as an *unlisted* add-on on addons.mozilla.org — Mozilla hands back a
signed `.xpi` that installs for good, and unlisted means it is never published
to the public directory.

```bash
npm install --global web-ext

# API credentials: https://addons.mozilla.org/developers/addon/api/key/
web-ext sign --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

The signed `.xpi` lands in `web-ext-artifacts/`. Open it with Zen, or drag it
onto the `about:addons` page.

## Setup

1. Grab a key at [openrouter.ai/keys](https://openrouter.ai/keys) — free to
   create, and there are free-tier models.
2. Click the extension icon, paste the key, hit **Verify key**.
3. Open any YouTube video with subtitles.

Pick a model in the same popup. The default is Gemini 2.0 Flash — fast and
cheap, which matters when a 40-minute video is a few hundred lines. Any
OpenRouter model ID works via **Custom model ID**.

## How it works

The interesting part is getting the subtitles at all.

The caption URLs in `ytInitialPlayerResponse` are missing YouTube's `pot`
(proof-of-origin) token, so requesting one directly returns an empty `200`. Only
YouTube's own player issues a request that carries a usable token.

So `src/page-hook.js` runs in the page's **MAIN world**, shadows `fetch` and
`XMLHttpRequest`, and waits for the player's own `/api/timedtext` request. To
trigger one on demand it flips a caption track on, captures the URL, and flips
it straight back off — the native captions must not stay up, since we draw our
own. The URL is then rewritten to `fmt=json3` and handed to the content script.

```
page-hook.js  (MAIN)      captures the tokenised caption URL
      │  postMessage
content.js    (ISOLATED)  fetches cues, syncs to currentTime, draws the overlay
      │  runtime.sendMessage
background.js (event page) holds the API key, calls OpenRouter, caches batches
```

The API key lives only in the background page. It is never exposed to the
content script and never reachable from YouTube's own JavaScript.

## Notes and limits

- Videos with no subtitle track cannot be translated — there is nothing to read.
  Whisper-style audio transcription is out of scope.
- Auto-generated (ASR) tracks are used only when no human-written track exists;
  they are noisier and translate worse.
- A human-written English track is preferred as the source, since models
  translate out of English most reliably.
- Translation costs whatever your chosen model charges per token. The cache
  means each video is paid for once.
- YouTube changes its player internals regularly. If subtitles stop appearing,
  the caption-capture hook is the thing that broke.

## Development

```
manifest.json         MV3, Gecko ID, event-page background
src/page-hook.js      MAIN world — caption URL capture
src/content.js        cue parsing, batching, playback sync, overlay
src/background.js     OpenRouter calls, caching, throttling
src/overlay.css       subtitle styling
popup/                settings UI
fonts/                Vazirmatn (SIL OFL 1.1)
```

Load it with `about:debugging`, then use **Inspect** on the add-on to see the
background console. Content-script logs are on the YouTube tab under the
`[persian-subs]` prefix.

## Credits

Inspired by [zakeri-dev/Youtube-Ai-Translator](https://github.com/zakeri-dev/Youtube-Ai-Translator),
which demonstrated the MAIN-world caption-capture approach. This is an
independent implementation, written for Firefox/Zen with its own architecture.

Persian text is set in [Vazirmatn](https://github.com/rastikerdar/vazirmatn) by
Saber Rastikerdar, used under the SIL Open Font License 1.1 (`fonts/OFL.txt`).

## License

MIT — see [LICENSE](LICENSE).
