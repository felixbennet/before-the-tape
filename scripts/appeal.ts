// Claims desk: answer a customer or marketplace claim point by point from the
// custody receipt, and say honestly what the packing evidence cannot prove.
//
//   pnpm appeal data/receipts/<clip>.json --claim "Customer says the box had only an empty pouch"
//
// Muse Spark reads the claim, the receipt facts and the proof image, splits the
// claim into points, and marks each contradicted / supported / unresolved with
// the frame that shows it. Code picks the action.
import fs from 'node:fs';
import path from 'node:path';
import { meta, spend, assertModel, PRICE } from '../src/meta.js';

const args = process.argv.slice(2);
const receiptPath = args[0];
const claim = args[args.indexOf('--claim') + 1];
if (!receiptPath || args.indexOf('--claim') === -1) throw new Error('usage: pnpm appeal <receipt.json> --claim "<claim text>"');
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const proof = receiptPath.replace(/\.json$/, '-proof.jpg');

const facts = {
  scan: receipt.scan, verdict: receipt.verdict, sha256: receipt.sha256, continuity: receipt.continuity, custody: receipt.custody,
  steps: (receipt.steps ?? []).map((s: { frame: number; seconds: number; what: string }) => `frame ${s.frame} (${s.seconds.toFixed(1)} s): ${s.what}`),
};
const prompt = [
  'You are preparing a seller\'s reply to a parcel claim, using only the packing evidence below. Do not invent evidence.',
  `CLAIM: ${claim}`,
  `EVIDENCE (from the packing video, checked by segmentation and vision models): ${JSON.stringify(facts)}`,
  'The image is the custody receipt: four key frames and the facts.',
  'points: split the claim into its separate assertions. For each: status "contradicted" if the evidence shows the opposite (cite the frame), "supported" if the evidence agrees with the customer, "unresolved" if packing evidence cannot settle it (for example anything that happens after the parcel leaves the bench, or a detail the camera never saw).',
  'cannot_prove: what this evidence does not show, stated plainly.',
  'reply: a short, polite reply to the marketplace or courier, under 110 words, citing frame numbers and the video hash. No legal threats, no accusations against the customer, no em dashes.',
].join('\n');
const schema = { type: 'object', additionalProperties: false, required: ['points', 'cannot_prove', 'reply'], properties: {
  points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['assertion', 'status', 'evidence', 'frame'],
    properties: { assertion: { type: 'string' }, status: { type: 'string', enum: ['contradicted', 'supported', 'unresolved'] }, evidence: { type: 'string' }, frame: { type: 'integer' } } } },
  cannot_prove: { type: 'array', items: { type: 'string' } }, reply: { type: 'string' } } };

assertModel('muse-spark-1.3', { customerData: false });
const res = await spend(4000 * PRICE.sparkIn + 3000 * PRICE.sparkOut, 'spark:appeal', () => meta.responses.create({
  model: 'muse-spark-1.3',
  input: [{ type: 'message', role: 'user', content: [
    { type: 'input_text', text: prompt },
    { type: 'input_image', image_url: `data:image/jpeg;base64,${fs.readFileSync(proof).toString('base64')}` },
  ] }] as never,
  text: { format: { type: 'json_schema', name: 'appeal', strict: true, schema } },
} as never));
const a = JSON.parse((res as { output_text?: string }).output_text ?? '{}') as { points: { assertion: string; status: string; evidence: string; frame: number }[]; cannot_prove: string[]; reply: string };

// Code decides: any supported point goes to a person; all contradicted means contest.
const action = a.points.some((p) => p.status === 'supported') ? 'REVIEW: part of the claim matches the evidence'
  : a.points.every((p) => p.status === 'contradicted') ? 'CONTEST: every point is contradicted by the packing video'
  : 'CONTEST WITH CARE: some points are outside what the packing video can show';
console.log(action);
for (const p of a.points) console.log(`  [${p.status}] ${p.assertion}  (frame ${p.frame}: ${p.evidence})`);
for (const c of a.cannot_prove) console.log(`  cannot prove: ${c}`);
console.log(`\nReply:\n${a.reply}`);
fs.mkdirSync('data/appeals', { recursive: true });
const out = `data/appeals/${path.parse(receiptPath).name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(out, JSON.stringify({ receipt: receiptPath, claim, action, ...a }, null, 2));
console.log(out);
