// Pull buildSegments straight out of content.js so we test the shipped code.
import { readFileSync } from 'node:fs';

const src = readFileSync(
  new URL('../src/content.js', import.meta.url),
  'utf8'
);

const consts = [...src.matchAll(/^\s*const (SEGMENT_\w+) = ([\d.]+);/gm)]
  .map((m) => `const ${m[1]} = ${m[2]};`)
  .join('\n');

const start = src.indexOf('  function buildSegments(cues) {');
const end = src.indexOf('\n  }', src.indexOf('return segments;', start)) + 4;
const fn = src.slice(start, end);

if (!consts || start < 0) throw new Error('could not extract buildSegments');
const buildSegments = new Function(`${consts}\n${fn}\nreturn buildSegments;`)();

const cue = (start, end, text) => ({ start, end, text });

// Realistic auto-generated caption fragments: fixed width, cutting across
// sentence boundaries, which is the case that motivated segmentation.
const asr = [
  cue(0.0, 2.1, 'You used to be able to sell buildings'),
  cue(2.1, 4.3, 'back in 2012, but now we can merge them.'),
  cue(4.3, 6.5, 'You had the weight of your troops'),
  cue(6.5, 8.8, 'training and spend resources on them.'),
  cue(20.0, 22.0, 'A totally separate thought after a long pause'),
];

const segments = buildSegments(asr);
console.log(`${asr.length} cues -> ${segments.length} segments\n`);
for (const s of segments) {
  console.log(`[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`);
}

const fail = [];
if (segments.length !== 3) fail.push(`expected 3 segments, got ${segments.length}`);
if (!segments[0]?.text.endsWith('merge them.')) fail.push('sentence 1 not joined');
if (segments[0]?.start !== 0.0 || segments[0]?.end !== 4.3) fail.push('bad span 1');
if (!segments[1]?.text.startsWith('You had the weight')) fail.push('sentence 2 wrong');
if (segments[2]?.start !== 20.0) fail.push('gap did not split');

// A run with no punctuation at all must still be broken up by the length cap.
const unpunctuated = Array.from({ length: 40 }, (_, i) =>
  cue(i * 2, i * 2 + 2, `word ${i} filler text here`)
);
const capped = buildSegments(unpunctuated);
const longest = Math.max(...capped.map((s) => s.text.length));
const longestSpan = Math.max(...capped.map((s) => s.end - s.start));
console.log(`\nunpunctuated: ${capped.length} segments, max ${longest} chars, max ${longestSpan}s`);
if (longest > 240) fail.push(`char cap exceeded: ${longest}`);
if (longestSpan > 14) fail.push(`duration cap exceeded: ${longestSpan}`);

// No cue text may be lost or duplicated.
const rejoined = segments.map((s) => s.text).join(' ');
for (const c of asr) {
  if (!rejoined.includes(c.text)) fail.push(`lost cue text: ${c.text}`);
}

console.log(fail.length ? `\nFAIL\n - ${fail.join('\n - ')}` : '\nall assertions passed');
process.exit(fail.length ? 1 : 0);
