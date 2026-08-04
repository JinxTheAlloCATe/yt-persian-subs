// Exercises the cue-to-sentence pipeline from content.js. Auto-generated
// captions arrive as fixed-width fragments that cut across sentences, so this
// covers both directions: fragments that must be joined, and cues holding a
// sentence boundary partway through that must be split.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

const consts = [...src.matchAll(/^\s*const ((?:SEGMENT|DISPLAY)_\w+) = ([\d.]+);/gm)]
  .map((m) => `const ${m[1]} = ${m[2]};`)
  .join('\n');
if (!consts) throw new Error('could not extract the segment constants');

/** Lift a function out of the source so the test covers what actually ships. */
function lift(signature, tailMarker) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`could not find ${signature}`);
  const end = src.indexOf('\n  }', src.indexOf(tailMarker, start)) + 4;
  return src.slice(start, end);
}

const api = new Function(`
  ${consts}
  ${lift('  function splitForDisplay(text, start, end) {', 'return chunks.map(')}
  ${lift('  function splitCueSentences(cue) {', 'return pieces.map(')}
  ${lift('  function buildSegments(rawCues) {', 'return segments;')}
  return { buildSegments, splitCueSentences };
`)();

const cue = (start, end, text) => ({ start, end, text });
const fail = [];

/* ------------------------------------------- joining split-up fragments */

const asr = [
  cue(0.0, 2.1, 'You used to be able to sell buildings'),
  cue(2.1, 4.3, 'back in 2012, but now we can merge them.'),
  cue(4.3, 6.5, 'You had the weight of your troops'),
  cue(6.5, 8.8, 'training and spend resources on them.'),
  cue(20.0, 22.0, 'A totally separate thought after a long pause'),
];

const segments = api.buildSegments(asr);
console.log(`${asr.length} fragments -> ${segments.length} sentences`);
for (const s of segments) console.log(`  [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`);

if (segments.length !== 3) fail.push(`expected 3 sentences, got ${segments.length}`);
if (!segments[0]?.text.endsWith('merge them.')) fail.push('sentence 1 not joined');
if (segments[0]?.start !== 0.0 || segments[0]?.end !== 4.3) fail.push('bad span on sentence 1');
if (!segments[1]?.text.startsWith('You had the weight')) fail.push('sentence 2 wrong');
if (segments[2]?.start !== 20.0) fail.push('long pause did not split');
for (const s of segments) {
  if (!s.sourceParts?.length) fail.push('segment has no paced source pieces');
}

/* ------------------------- splitting a boundary that falls inside a cue */

// The reported case: two whole sentences shown on screen as one block.
const midCue = cue(0, 6, 'but now they are free and instant. Here are 10 features from the old game');
const split = api.splitCueSentences(midCue);
console.log(`\nboundary inside a cue -> ${split.length} pieces`);
for (const s of split) console.log(`  [${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`);

if (split.length !== 2) fail.push(`expected 2 pieces, got ${split.length}`);
if (!split[0]?.text.endsWith('instant.')) fail.push('first piece did not end at the full stop');
if (!split[1]?.text.startsWith('Here are')) fail.push('second piece did not start the new sentence');
if (split[0]?.start !== 0 || split[split.length - 1]?.end !== 6) fail.push('cue span not preserved');
if (api.splitCueSentences(cue(0, 2, 'no boundary here')).length !== 1) {
  fail.push('a cue without a boundary was split');
}

// End to end: the same text through buildSegments must not stay glued.
const glued = api.buildSegments([
  cue(0, 3, 'You had the weight of your troops training, but now they are free.'),
  cue(3, 6, 'Here are 10 features that are now totally different.'),
]);
console.log(`\nglued pair -> ${glued.length} sentences`);
if (glued.length !== 2) fail.push(`two sentences collapsed into ${glued.length}`);

/* --------------------------------------------------------- length caps */

const unpunctuated = Array.from({ length: 40 }, (_, i) =>
  cue(i * 2, i * 2 + 2, `word ${i} filler text here`)
);
const capped = api.buildSegments(unpunctuated);
const longest = Math.max(...capped.map((s) => s.text.length));
const longestSpan = Math.max(...capped.map((s) => s.end - s.start));
console.log(`\nunpunctuated: ${capped.length} segments, max ${longest} chars, max ${longestSpan}s`);
if (longest > 240) fail.push(`char cap exceeded: ${longest}`);
if (longestSpan > 14) fail.push(`duration cap exceeded: ${longestSpan}`);

// No cue text may be lost.
const rejoined = segments.map((s) => s.text).join(' ');
for (const c of asr) {
  if (!rejoined.includes(c.text)) fail.push(`lost cue text: ${c.text}`);
}

console.log(fail.length ? `\nFAIL\n - ${fail.join('\n - ')}` : '\nall assertions passed');
process.exit(fail.length ? 1 : 0);
