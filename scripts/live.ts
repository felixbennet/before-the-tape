// Live pause: check the scanned variant while the packer is still working.
//
//   pnpm live <clip> --scan-at 4.0 --seal-at 17.8 --ref "<scanned photo>|<product>" --decoy "<photo>" ...
//
// The clip plays in real time as a stand-in for the bench camera feed. At the
// barcode scan (time from the scan log; --scan-at for a recorded clip) the last
// second of frames goes to Muse Spark with the shuffled catalogue line-up. If the
// wallet in hand is not the scanned variant, the bench gets PAUSE before the seal.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shuffleCandidates } from '../src/spark.js';
import { pickVariant } from '../src/identify.js';

const args = process.argv.slice(2);
const clipPath = args[0];
const flag = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const scanAt = Number(flag('scan-at')[0]);
const sealAt = Number(flag('seal-at')[0] ?? NaN);
const [refImage, product = 'scanned product'] = (flag('ref')[0] ?? '').split('|');
const item = flag('item')[0] ?? 'wallet';
if (!clipPath || !Number.isFinite(scanAt) || !refImage) throw new Error('usage: pnpm live <clip> --scan-at <s> [--seal-at <s>] --ref "<photo>|<product>" --decoy <photo>...');
const cand = shuffleCandidates({ phrase: item, expected: 1, image: refImage, decoys: flag('decoy') })!;

const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const log: { t: number; event: string }[] = [];
const say = (event: string) => { log.push({ t: +now().toFixed(2), event }); console.log(`${now().toFixed(1).padStart(5)} s  ${event}`); };

say(`camera on, ${path.basename(clipPath)} playing in real time`);
await new Promise((r) => setTimeout(r, scanAt * 1000));
say(`barcode scan: 1 x ${item}, ${product}`);

// The frames the camera has already seen: the second before the scan, full resolution.
const dir = fs.mkdtempSync('/tmp/live-');
const frames = [scanAt - 1.0, scanAt].map((s, i) => {
  const f = `${dir}/f${i}.jpg`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, s)), '-i', clipPath, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '3', f]);
  return f;
});
say('checking the wallet in hand against the catalogue line-up');
// Low reasoning effort: the answer has to land before the seal.
const answer = await pickVariant(frames, cand.photos, item, 'low');
const verdict = answer.pick === cand.answer ? 'CONTINUE' : answer.pick === 0 ? 'PAUSE: hold the wallet up to the camera' : 'PAUSE: wrong product in hand';
say(`Muse Spark picked photo ${answer.pick} (scanned is ${cand.answer}): ${verdict}`);
const answeredAt = now();
if (Number.isFinite(sealAt)) say(`${answeredAt < sealAt ? `answered ${(sealAt - answeredAt).toFixed(1)} s before` : `answered ${(answeredAt - sealAt).toFixed(1)} s after`} the seal (${sealAt} s)`);

fs.mkdirSync('data/live', { recursive: true });
const out = `data/live/${path.parse(clipPath).name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(out, JSON.stringify({ clip: clipPath, product, scanAt, sealAt, candidates: cand, answer, verdict, answeredAt, latency: +(answeredAt - scanAt).toFixed(2), log }, null, 2));
console.log(`\n${verdict}  (latency ${(answeredAt - scanAt).toFixed(1)} s)  ${answer.note}\n${out}`);
