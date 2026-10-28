// Checks one packing clip against what the scan says should be in the parcel.
//
//   pnpm check <clip> --item "belt=1" --item "belt buckle=1" [--parcel "cardboard box"] [--fps 5]
//
// SAM 3.1 finds the parcel and tracks each item phrase through the clip; the
// events are reconciled against the expected counts. Overall result: mismatch
// if any item disagrees, otherwise uncertain if anything was unclear, otherwise
// consistent.
import fs from 'node:fs';
import { prepareClip, segment } from '../src/sam.js';
import { packEvents, parcelRegion, verdict, type PackEvent, type Verdict } from '../src/events.js';

const args = process.argv.slice(2);
const clipPath = args[0];
const flag = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const items = flag('item').map((s) => {
  const [phrase, n] = s.split('=');
  return { phrase: phrase.trim(), expected: Number(n) };
});
if (!clipPath || !items.length || items.some((i) => !i.phrase || !Number.isInteger(i.expected))) {
  throw new Error('usage: pnpm check <clip> --item "belt=1" [--item "belt buckle=1"] [--parcel "cardboard box"] [--fps 5]');
}
const parcelPhrase = flag('parcel')[0] ?? 'cardboard box';
const fps = Number(flag('fps')[0] ?? 5);

const clip = prepareClip(clipPath, fps);
const parcel = parcelRegion(await segment(clip.media, parcelPhrase, clip.frames));
if (!parcel) throw new Error(`no "${parcelPhrase}" found in the clip; cannot check what went into it`);

const results: { phrase: string; expected: number; verdict: Verdict; net: number; events: PackEvent[] }[] = [];
for (const item of items) {
  const events = packEvents(await segment(clip.media, item.phrase, clip.frames), parcel, { totalFrames: clip.frames });
  const v = verdict(events, item.expected);
  results.push({ ...item, ...v, events });
  console.log(`${item.phrase}: expected ${item.expected}, saw net ${v.net} -> ${v.verdict.toUpperCase()}`);
  for (const e of events) console.log(`  ${(e.frame / fps).toFixed(1)}s  ${e.kind.padEnd(9)} ${e.why}`);
}

const order: Verdict[] = ['mismatch', 'uncertain', 'consistent'];
const overall = order.find((v) => results.some((r) => r.verdict === v)) ?? 'consistent';
console.log(`\nPARCEL: ${overall.toUpperCase()}`);

fs.mkdirSync('data/checks', { recursive: true });
fs.writeFileSync(`data/checks/${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  JSON.stringify({ clip: clipPath, fps, frames: clip.frames, parcel, overall, results }, null, 2));
