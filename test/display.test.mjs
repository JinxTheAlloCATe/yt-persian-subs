// Checks splitForDisplay from content.js: a translated sentence is broken into
// readable pieces whose timings tile the sentence's span exactly, with no gap,
// no overlap, and no word split across pieces.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');

const consts = [...src.matchAll(/^\s*const (DISPLAY_\w+) = ([\d.]+);/gm)]
  .map((m) => `const ${m[1]} = ${m[2]};`)
  .join('\n');
const start = src.indexOf('  function splitForDisplay(text, start, end) {');
const end = src.indexOf('\n  }', src.indexOf('return chunks.map(', start)) + 4;

if (!consts || start < 0) throw new Error('could not extract splitForDisplay');
const splitForDisplay = new Function(
  `${consts}\n${src.slice(start, end)}\nreturn splitForDisplay;`
)();

const fail = [];
const sentence =
  'قبلاً می‌شد ساختمون‌ها رو در سال ۲۰۱۲ فروخت، ولی الان می‌تونیم ادغامشون کنیم و منابع رو نگه داریم.';

const parts = splitForDisplay(sentence, 10, 22);
console.log(`"${sentence.slice(0, 40)}…"  ->  ${parts.length} pieces over 12s`);
for (const p of parts) {
  console.log(`  [${p.start.toFixed(2)}-${p.end.toFixed(2)}] ${p.text}`);
}

if (parts.length < 2) fail.push('long sentence was not split');
if (parts[0].start !== 10) fail.push('does not start at the sentence start');
if (Math.abs(parts[parts.length - 1].end - 22) > 1e-9) fail.push('does not end at the sentence end');

for (let i = 1; i < parts.length; i++) {
  if (Math.abs(parts[i].start - parts[i - 1].end) > 1e-9) {
    fail.push(`gap or overlap between piece ${i - 1} and ${i}`);
  }
}
// Pieces may exceed DISPLAY_MAX_CHARS up to the merge tolerance, which exists
// so a stray trailing word gets folded back rather than flashing up alone.
const HARD_LIMIT = Math.ceil(52 * 1.35);
for (const p of parts) {
  if (p.end <= p.start) fail.push(`non-positive duration: ${p.text}`);
  if (p.text.length > HARD_LIMIT && p.text.split(/\s+/).length > 1) {
    fail.push(`piece over the hard limit: ${p.text.length} chars`);
  }
}

// No piece should be a lone runt when it could have been merged.
if (parts.length > 1) {
  const last = parts[parts.length - 1];
  const previous = parts[parts.length - 2];
  if (last.text.length < 52 * 0.4 && previous.text.length + last.text.length + 1 <= HARD_LIMIT) {
    fail.push(`trailing runt left unmerged: "${last.text}"`);
  }
}

// Words must survive intact and in order.
const rejoined = parts.map((p) => p.text).join(' ');
if (rejoined.split(/\s+/).join(' ') !== sentence.split(/\s+/).join(' ')) {
  fail.push('text was altered while splitting');
}

// A short line should stay in one piece spanning its whole cue.
const short = splitForDisplay('سلام دنیا', 3, 5);
console.log(`\nshort line -> ${short.length} piece(s)`);
if (short.length !== 1) fail.push('short line was split unnecessarily');
if (short[0].start !== 3 || short[0].end !== 5) fail.push('short line span wrong');

// Degenerate inputs must not produce NaN timings.
if (splitForDisplay('', 0, 1).length !== 0) fail.push('empty text should yield no pieces');
const zero = splitForDisplay('یک دو سه', 5, 5);
if (zero.some((p) => Number.isNaN(p.start) || Number.isNaN(p.end))) {
  fail.push('zero-length cue produced NaN');
}

console.log(fail.length ? `\nFAIL\n - ${fail.join('\n - ')}` : '\nall assertions passed');
process.exit(fail.length ? 1 : 0);
