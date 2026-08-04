// Exercises assessTranslation from background.js, which decides whether a
// batch actually came back in Persian. Without it, a model that ignores the
// instructions produces subtitles that are silently still in English.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

const persianConst = src.match(/^const PERSIAN = .+$/m)?.[0];
const start = src.indexOf('function assessTranslation(lines) {');
const end = src.indexOf('\n}', src.indexOf('return null;', start)) + 2;

if (!persianConst || start < 0) throw new Error('could not extract assessTranslation');
const assess = new Function(
  `${persianConst}\n${src.slice(start, end)}\nreturn assessTranslation;`
)();

const fail = [];
const check = (label, lines, shouldFlag) => {
  const problem = assess(lines);
  const flagged = Boolean(problem);
  const status = flagged === shouldFlag ? 'ok  ' : 'FAIL';
  if (flagged !== shouldFlag) fail.push(label);
  console.log(`${status} ${label}${problem ? ` -> ${problem}` : ''}`);
};

check('good Persian batch', ['سلام دنیا', 'این یک آزمایش است', 'خوب کار می‌کند'], false);
check('all empty', ['', '', ''], true);
check('English echoed back', ['Hello world', 'This is a test', 'Works fine'], true);
check('mostly untranslated', ['سلام', 'Hello world', 'Another English line'], true);
check('mostly blank', ['سلام دنیا', '', '', '', ''], true);
// Numbers, names and [Music] legitimately survive translation unchanged.
check(
  'Persian with proper nouns kept',
  ['[Music]', 'او به YouTube رفت', 'در سال ۲۰۱۲ بود', 'ما آن را ادغام کردیم'],
  false
);

console.log(fail.length ? `\nFAIL: ${fail.join(', ')}` : '\nall assertions passed');
process.exit(fail.length ? 1 : 0);
