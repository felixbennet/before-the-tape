// Checks one packing clip against what the scan says should be in the parcel.
//
//   pnpm check <clip> --item "wallet=1" [--item "leather care card=1"] [--parcel "cardboard box"] [--fps 5]
//
// 1. SAM 3.1 finds the parcel and tracks each item phrase through the clip.
// 2. A first pass turns SAM's tracks into in / out / uncertain events.
// 3. Muse Spark reads one frame per second with SAM's boxes drawn on them and
//    gives the verdict, following nested packaging and citing frames.
import fs from 'node:fs';
import path from 'node:path';
import { prepareClip, segment, type Hit } from '../src/sam.js';
import { closeups, packEvents, parcelTrack, pickFrames, trackEdges, verdict, type PackEvent, type Verdict } from '../src/events.js';
import { annotatedFrames, crops, sparkVerdict, type Expected, type Layer } from '../src/spark.js';

const args = process.argv.slice(2);
const clipPath = args[0];
const flag = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const items: Expected[] = flag('item').map((s) => {
  const [phrase, n] = s.split('=');
  return { phrase: phrase.trim(), expected: Number(n) };
});
const fps = Number(flag('fps')[0] ?? 5);
if (!clipPath || !items.length || items.some((i) => !i.phrase || !Number.isInteger(i.expected) || i.expected < 0) || !Number.isInteger(fps) || fps < 1 || fps > 10) {
  throw new Error('usage: pnpm check <clip> --item "wallet=1" [--item "white printed card=1"] [--ref "wallet=<photo>|<product>"] [--decoy "wallet=<photo>"] [--parcel "cardboard box"] [--fps 5]');
}
// --ref "wallet=<photo>|<product>" is the catalogue photo of the scanned variant;
// --decoy "wallet=<photo>" adds a look-alike variant for Spark to tell apart.
const itemFor = (flagName: string, value: string) => {
  const [phrase, rest = ''] = value.split(/=(.*)/s);
  const item = items.find((i) => i.phrase === phrase.trim());
  if (!item || !rest) throw new Error(`--${flagName} "${value}" must name an --item phrase and a photo`);
  return { item, rest };
};
for (const r of flag('ref')) {
  const { item, rest } = itemFor('ref', r);
  const [image, product] = rest.split('|');
  Object.assign(item, { image: image.trim(), product: product?.trim() });
}
for (const d of flag('decoy')) {
  const { item, rest } = itemFor('decoy', d);
  item.decoys = [...(item.decoys ?? []), rest.trim()];
}
if (items.some((i) => i.decoys && !i.image)) throw new Error('--decoy needs a --ref for the same item');
const parcelPhrase = flag('parcel')[0] ?? 'cardboard box';

const clip = prepareClip(clipPath, fps);
// SAM tracks depend only on clip, fps and phrase, so counterfactual runs (other
// scan lists or photos) reuse them and only pay for Spark.
const tracked = async (phrase: string): Promise<Hit[]> => {
  const file = `data/cache/${path.parse(clipPath).name}-${fs.statSync(clipPath).mtimeMs}-${fps}-${phrase.replace(/\W+/g, '_')}.json`;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const hits = await segment(clip.media, phrase, clip.frames);
  fs.mkdirSync('data/cache', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hits));
  return hits;
};
const parcelHits = await tracked(parcelPhrase);
const parcel = parcelTrack(parcelHits);
if (!parcel) throw new Error(`no "${parcelPhrase}" found in the clip; cannot check what went into it`);

const colors = ['green', 'orange', 'magenta', 'cyan'];
const layers: Layer[] = [{ label: parcelPhrase, color: 'blue', hits: parcelHits }];
const firstPass: { phrase: string; expected: number; verdict: Verdict; net: number; events: PackEvent[] }[] = [];
console.log('first pass (SAM tracks only):');
const itemHits = await Promise.all(items.map((item) => tracked(item.phrase)));
for (const [i, item] of items.entries()) {
  const hits = itemHits[i];
  layers.push({ label: item.phrase, color: colors[i % colors.length], hits });
  const events = packEvents(hits, parcel, { totalFrames: clip.frames });
  const v = verdict(events, item.expected);
  firstPass.push({ ...item, ...v, events });
  console.log(`  ${item.phrase}: expected ${item.expected}, net ${v.net} -> ${v.verdict}`);
}

const edges = layers.slice(1).flatMap((l) => trackEdges(l.hits, clip.frames));
const frames = annotatedFrames(clip.file, layers, pickFrames(clip.frames, fps, edges), fps);
for (const [i, item] of items.entries()) if (item.image) item.closeups = crops(clipPath, closeups(itemHits[i]), fps);
const spark = await sparkVerdict(frames, items, layers.map((l) => l.label), fps);
console.log(`\nMuse Spark (${frames.length} frames): ${spark.summary}`);
for (const s of spark.steps) console.log(`  ${s.seconds.toFixed(1)}s  frame ${s.frame}  ${s.what}`);
for (const [i, c] of spark.counts.entries()) {
  console.log(`  ${c.item}: expected ${c.expected}, seen in ${c.seen_in}, variant: ${spark.identity[i] ?? '?'}`);
  if (spark.candidates[i]) console.log(`    picked ${c.reference_pick} of ${spark.candidates[i]!.photos.length} (scanned is ${spark.candidates[i]!.answer}): ${c.reference_note}`);
}
for (const w of spark.why) console.log(`  ! ${w}`);
console.log(`\nPARCEL: ${spark.verdict.toUpperCase()}${spark.verdict !== spark.spark_verdict ? ` (Spark alone said ${spark.spark_verdict})` : ''}`);

fs.mkdirSync('data/checks', { recursive: true });
fs.writeFileSync(`data/checks/${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  JSON.stringify({ clip: clipPath, fps, frames: clip.frames, firstPass, spark }, null, 2));
