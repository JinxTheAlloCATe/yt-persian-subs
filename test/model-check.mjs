/*
 * Runs the add-on's real translation prompt against several OpenRouter models
 * and reports which ones actually come back in Persian.
 *
 * The prompt and the response parser are lifted straight out of src/background.js,
 * so this tests what ships rather than a paraphrase of it.
 *
 *   node test/model-check.mjs [model-id ...]
 *
 * Needs a key in ~/.openrouter-key or $OPENROUTER_API_KEY. Never pass one on
 * the command line — it would land in your shell history.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ------------------------------------------------------------------ key */

function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    const file = readFileSync(join(homedir(), '.openrouter-key'), 'utf8');
    const match = file.match(/OPENROUTER_API_KEY\s*=\s*"?([^"\n]+)"?/);
    const key = match?.[1]?.trim();
    if (key && !key.includes('...')) return key;
  } catch {
    /* fall through to the error below */
  }
  console.error('No API key. Put one in ~/.openrouter-key or $OPENROUTER_API_KEY.');
  process.exit(2);
}

/* ------------------------------------- lift the real prompt and parser */

const src = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

function lift(startMarker, endMarker, exportName) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`could not find ${startMarker}`);
  const end = src.indexOf(endMarker, start) + endMarker.length;
  return src.slice(start, end);
}

const systemPrompt = lift('const SYSTEM_PROMPT = [', "].join('\\n');");
const contextFn = lift('function buildContextBlock(', '\n}');
const persianConst = src.match(/^const PERSIAN = .+$/m)[0];
const assessFn = lift('function assessTranslation(', '\n}');
const extractFn = lift('function extractJson(', '\n}');
const linesFn = lift('function linesFromResponse(', '\n}');

const lifted = new Function(`
  ${systemPrompt}
  ${contextFn}
  ${persianConst}
  ${assessFn}
  ${extractFn}
  ${linesFn}
  return { SYSTEM_PROMPT, buildContextBlock, assessTranslation, linesFromResponse };
`)();

/* ----------------------------------------------------------- test data */

// Sentence-merged segments, the shape the add-on actually sends.
const SAMPLE = [
  'You used to be able to sell buildings back in 2012, but now we can merge them.',
  'You had the weight of your troops training and spend resources on them.',
  'This is the biggest update the game has had in years, no question about it.',
  'Let me know down in the comments what you think about these changes.',
  '[Music]',
  'The town hall level twelve upgrade costs a lot more than people expected.',
  'I want to walk through each of the new troop levels one at a time here.',
  'If you are sitting on a lot of resources this is the moment to spend them.',
  'They also reworked how the clan castle handles defending troops entirely.',
  'That change alone is going to shift the meta quite a bit in my opinion.',
];

// Real batches are BATCH_SIZE segments, not a handful. Truncated output is the
// obvious suspect for a failure that only shows up in the add-on.
const COUNT = Number(process.env.LINES_COUNT || 5);
const LINES = Array.from(
  { length: COUNT },
  (_, i) => SAMPLE[i % SAMPLE.length]
);

const CONTEXT = {
  title: 'Clash of Clans - Everything New in the Summer Update',
  author: 'Judo Sloth Gaming',
  keywords: ['clash of clans', 'update', 'town hall'],
  description:
    'Breaking down every change in the latest Clash of Clans update, including ' +
    'building merges, new troop levels and the reworked home village layout.',
  before: [
    {
      source: 'Welcome back everyone to another video.',
      persian: 'به همگی خوش آمدید به یک ویدئوی دیگر.',
    },
  ],
  after: ['That is everything for today, I will see you next time.'],
};

const DEFAULT_MODELS = [
  'google/gemini-3.6-flash',
  '~deepseek/deepseek-v4-flash-latest',
  'deepseek/deepseek-chat-v3.1',
  'openai/gpt-4o-mini',
  'anthropic/claude-sonnet-5',
];

/* ----------------------------------------------------------------- run */

async function tryModel(key, model, { json }) {
  const numbered = LINES.map((line, i) => `${i + 1}. ${line}`).join('\n');
  const contextBlock = lifted.buildContextBlock(CONTEXT);
  const instruction =
    `Translate these ${LINES.length} subtitle lines into Persian. ` +
    `Return ${LINES.length} translations.`;

  const body = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: lifted.SYSTEM_PROMPT },
      { role: 'user', content: `${contextBlock}\n\n---\n\n${instruction}\n\n${numbered}` },
    ],
  };
  if (json) body.response_format = { type: 'json_object' };

  const started = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'Persian Subtitles model check',
    },
    body: JSON.stringify(body),
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { status: `HTTP ${res.status}`, detail: detail.slice(0, 120), elapsed };
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return { status: 'empty response', elapsed };

  const parsed = lifted.linesFromResponse(content, LINES.length);
  if (!parsed) {
    return { status: 'UNPARSEABLE', elapsed, raw: content.slice(0, 150) };
  }

  const problem = lifted.assessTranslation(parsed);
  return {
    status: problem ? 'REJECTED' : 'ok',
    problem,
    elapsed,
    sample: parsed[0] || '(empty)',
    raw: problem ? content.slice(0, 150) : null,
  };
}

const key = apiKey();
const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;

for (const model of models) {
  for (const mode of [{ json: false }, { json: true }]) {
    const label = mode.json ? 'json_object' : 'plain     ';
    let result;
    try {
      result = await tryModel(key, model, mode);
    } catch (err) {
      result = { status: 'threw', detail: String(err.message) };
    }
    const head = `${model.padEnd(36)} ${label} ${String(result.status).padEnd(12)} ${result.elapsed || '-'}s`;
    console.log(head);
    if (result.sample) console.log(`    sample: ${result.sample}`);
    if (result.problem) console.log(`    reason: ${result.problem}`);
    if (result.raw) console.log(`    raw   : ${result.raw.replace(/\n/g, ' ')}`);
    if (result.detail) console.log(`    detail: ${result.detail.replace(/\n/g, ' ')}`);
  }
  console.log();
}
