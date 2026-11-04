// Is this the packing video we recorded, untouched? For when a claim, a courier
// or a marketplace receives a copy of the evidence.
//
//   pnpm verify <clip> --receipt data/receipts/<clip>.json
//
// 1. SHA-256 against the hash written into the custody receipt at packing time.
// 2. Frame-to-frame jumps (ffmpeg scdet): a cut or a splice in continuous bench
//    footage jumps far above anything a real take does (our takes peak near 1.2).
// 3. For each jump, Muse Spark looks at the frame before and after and says what changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { meta, spend, assertModel, PRICE } from '../src/meta.js';

const args = process.argv.slice(2);
const clipPath = args[0];
const receiptPath = args[args.indexOf('--receipt') + 1];
if (!clipPath || args.indexOf('--receipt') === -1) throw new Error('usage: pnpm verify <clip> --receipt <receipt.json>');
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const JUMP = 4; // scene-change score; real bench takes stay under ~1.3

const sha = crypto.createHash('sha256').update(fs.readFileSync(clipPath)).digest('hex');
const hashMatches = sha === receipt.sha256;
const log = spawnSync('ffmpeg', ['-hide_banner', '-i', clipPath, '-vf', 'scdet=threshold=0,metadata=print:file=-', '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
const scores: { t: number; s: number }[] = [];
let t = 0;
for (const line of log.split('\n')) {
  const pt = line.match(/pts_time:([\d.]+)/);
  if (pt) t = parseFloat(pt[1]);
  const sc = line.match(/lavfi\.scd\.score=([\d.]+)/);
  if (sc) scores.push({ t, s: parseFloat(sc[1]) });
}
const jumps = scores.filter((x) => x.s > JUMP);
const maxScore = Math.max(...scores.map((x) => x.s));

const frameAt = (sec: number, file: string) => {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, sec)), '-i', clipPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', file]);
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
};
const tmp = fs.mkdtempSync('/tmp/verify-');
const explained: { t: number; score: number; change: string; same_take: string }[] = [];
for (const j of jumps.slice(0, 3)) {
  assertModel('muse-spark-1.3', { customerData: false });
  const content = [
    { type: 'input_text', text: 'Two consecutive frames from what should be one continuous overhead video of a packing bench. Did the video jump (a cut or a different recording spliced in)? same_take: "yes" if the second frame plausibly follows the first in one continuous take, "no" if it jumped. change: one sentence naming what changed (item, hands, objects, positions).' },
    { type: 'input_image', image_url: frameAt(j.t - 0.1, `${tmp}/a.jpg`) },
    { type: 'input_image', image_url: frameAt(j.t + 0.02, `${tmp}/b.jpg`) },
  ];
  const res = await spend(3000 * PRICE.sparkIn + 1500 * PRICE.sparkOut, 'spark:verify-jump', () => meta.responses.create({
    model: 'muse-spark-1.3',
    input: [{ type: 'message', role: 'user', content }] as never,
    text: { format: { type: 'json_schema', name: 'jump', strict: true, schema: { type: 'object', additionalProperties: false, required: ['same_take', 'change'],
      properties: { same_take: { type: 'string', enum: ['yes', 'no'] }, change: { type: 'string' } } } } },
    reasoning: { effort: 'low' },
  } as never));
  const r = JSON.parse((res as { output_text?: string }).output_text ?? '{}') as { same_take: string; change: string };
  explained.push({ t: +j.t.toFixed(2), score: +j.s.toFixed(1), ...r });
}

const verdict = !jumps.length && hashMatches ? 'VALID: the recorded take, untouched'
  : jumps.length ? `TAMPERED: ${jumps.length === 1 ? 'a cut' : `${jumps.length} jumps`} at ${jumps.map((j) => `${j.t.toFixed(1)} s`).join(', ')}`
  : 'NOT THE RECORDED FILE: content looks continuous, but this is not the file hashed at packing';
console.log(`${path.basename(clipPath)}: ${verdict}`);
console.log(`  sha256 ${hashMatches ? 'matches the receipt' : 'does NOT match the receipt'}; biggest frame jump ${maxScore.toFixed(1)} (real takes stay under ~1.3)`);
for (const e of explained) console.log(`  ${e.t} s (score ${e.score}): Muse Spark: ${e.same_take === 'no' ? 'jumped' : 'looks continuous'}, ${e.change}`);
fs.mkdirSync('data/forgery', { recursive: true });
fs.writeFileSync(`data/forgery/${path.parse(clipPath).name}-verify.json`, JSON.stringify({ clip: clipPath, sha, hashMatches, maxScore, jumps, explained, verdict }, null, 2));
