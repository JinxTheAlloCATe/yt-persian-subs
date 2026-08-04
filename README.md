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
- Rebuilds sentences first. Auto-generated cues are cut to a fixed width, so a
  sentence normally ends partway through one; Persian puts the verb last, and a
  fragment ending before its verb cannot be translated well in isolation.
- Sends those sentences to OpenRouter in batches of 20, carrying the video's
  title and the previous batch's translations so terminology stays consistent.
- Paints the Persian over the video, right-to-left, in Vazirmatn — in
  speech-sized pieces timed across each sentence rather than a wall of text.
- Drops non-speech annotations like `[Music]` instead of translating them.
- Caches every translated batch, so re-watching a video costs nothing.
- Optionally keeps the original line visible underneath.

Translations are keyed by video **and** model, so switching models re-translates
rather than serving a stale result.

The popup also sets subtitle size and colour, keeps an editable shortlist of
models, and shows estimated spend so far.

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

Get API credentials from
[the AMO key page](https://addons.mozilla.org/developers/addon/api/key/) and
keep them in a file outside the repo — never on the command line, where they
land in shell history:

```bash
# ~/.amo-credentials, chmod 600
WEB_EXT_API_KEY="user:00000000:000"
WEB_EXT_API_SECRET="…"
```

```bash
npm install --global web-ext

set -a; . ~/.amo-credentials; set +a
web-ext sign --channel=unlisted
```

Bump `version` in `manifest.json` first — AMO rejects a version it has already
seen. The signed `.xpi` lands in `web-ext-artifacts/`; drag it onto
`about:addons` in Zen.

## Setup

1. Grab a key at [openrouter.ai/keys](https://openrouter.ai/keys) — free to
   create, and there are free-tier models.
2. Click the extension icon, paste the key, hit **Verify key**.
3. Open any YouTube video with subtitles.

Pick a model in the same popup. The field accepts any OpenRouter model ID and
autocompletes from their live catalogue, showing the price per million tokens
and warning if an ID does not exist. Remove any shortcut with its ×, or save
whatever is in the field as a new one.

**Model choice is what drives cost.** Output tokens dominate translation, and
they vary by more than an order of magnitude:

| Model | ~cost per 16-minute video |
| --- | --- |
| `~deepseek/deepseek-v4-flash-latest` (default) | $0.0025 |
| `openai/gpt-5.6-luna` | $0.0062 |
| `openai/gpt-4o-mini` | $0.0066 |
| `google/gemini-3.6-flash` | $0.078 |

The popup tracks tokens used and estimates what they cost, so this is visible
as it accumulates rather than at the end of the month.

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
