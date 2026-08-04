// Checks stripSoundMarkers from content.js. Caption tracks annotate non-speech
// as [Music], [Applause], ♪ and so on; those are not dialogue and must not be
// shown or sent to a model. The risk is over-eager stripping, so most of these
// cases are things that must survive untouched.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

const consts = [...src.matchAll(/^\s*const (SOUND_MARKER|WHOLE_PARENTHETICAL) = .+$/gm)]
  .map((m) => m[0].trim())
  .join('\n');
const start = src.indexOf('  function stripSoundMarkers(text) {');
const end = src.indexOf('\n  }', start) + 4;
if (!consts || start < 0) throw new Error('could not extract stripSoundMarkers');

const strip = new Function(`${consts}\n${src.slice(start, end)}\nreturn stripSoundMarkers;`)();

const fail = [];
const check = (input, expected, why) => {
  const got = strip(input);
  const ok = got === expected;
  if (!ok) fail.push(`${why}\n     input: ${JSON.stringify(input)}\n     want : ${JSON.stringify(expected)}\n     got  : ${JSON.stringify(got)}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
};

// Annotations that should disappear entirely.
check('[Music]', '', 'bare music marker');
check('[Applause]', '', 'bare applause marker');
check('♪♪', '', 'musical notes');
check('  [ Instrumental Break ]  ', '', 'padded marker');
check('(music)', '', 'whole-cue parenthetical');
check('[موسیقی]', '', 'localised marker');

// Annotations mixed into real speech: strip the marker, keep the words.
check('[Music] and we are back', 'and we are back', 'leading marker');
check('so anyway [Applause] that is it', 'so anyway that is it', 'mid-sentence marker');
check('♪ singing along ♪', 'singing along', 'notes around speech');

// Speech that must survive untouched — the real risk of a filter like this.
check('You had the weight of your troops', 'You had the weight of your troops', 'plain speech');
check(
  'the town hall (level 12) is expensive',
  'the town hall (level 12) is expensive',
  'parenthesis inside a sentence'
);
check('it costs 25 gold', 'it costs 25 gold', 'numbers');
check('I said "stop" and he did', 'I said "stop" and he did', 'quotes');
check(
  'this is a long parenthetical aside that runs well past the limit and is clearly speech',
  'this is a long parenthetical aside that runs well past the limit and is clearly speech',
  'long text untouched'
);

console.log(fail.length ? `\nFAIL\n - ${fail.join('\n - ')}` : '\nall assertions passed');
process.exit(fail.length ? 1 : 0);
