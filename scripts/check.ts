// Checks one packing clip against what the scan says should be in the parcel.
//
//   pnpm check <clip> --item "wallet=1" [--item "leather care card=1"] [--parcel "cardboard box"] [--fps 5]
//
// 1. SAM 3.1 finds the parcel and tracks each item phrase through the clip.
// 2. A first pass turns SAM's tracks into in / out / uncertain events.
// 3. Muse Spark reads one frame per second with SAM's boxes drawn on them and
//    gives the verdict, following nested packaging and citing frames.
import fs from 'node:fs';
import { prepareClip, segment } from '../src/sam.js';
import { packEvents, parcelTrack, pickFrames, trackEdges, verdict, type PackEvent, type Verdict } from '../src/events.js';
import { annotatedFrames, sparkVerdict, type Layer } from '../src/spark.js';

const args = process.argv.slice(2);
const clipPath = args[0];
const flag = (name: string) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const items = flag('item').map((s) => {
  const [phrase, n] = s.split('=');
  return { phrase: phrase.trim(), expected: Number(n) };
});
if (!clipPath || !items.length || items.some((i) => !i.phrase || !Number.isInteger(i.expected))) {
  throw new Error('usage: pnpm check <clip> --item "wallet=1" [--item "leather care card=1"] [--parcel "cardboard box"] [--fps 5]');
}
const parcelPhrase = flag('parcel')[0] ?? 'cardboard box';
const fps = Number(flag('fps')[0] ?? 5);

const clip = prepareClip(clipPath, fps);
const parcelHits = await segment(clip.media, parcelPhrase, clip.frames);
const parcel = parcelTrack(parcelHits);
if (!parcel) throw new Error(`no "${parcelPhrase}" found in the clip; cannot check what went into it`);

const colors = ['green', 'orange', 'magenta', 'cyan'];
const layers: Layer[] = [{ label: parcelPhrase, color: 'blue', hits: parcelHits }];
const firstPass: { phrase: string; expected: number; verdict: Verdict; net: number; events: PackEvent[] }[] = [];
console.log('first pass (SAM tracks only):');
for (const [i, item] of items.entries()) {
  const hits = await segment(clip.media, item.phrase, clip.frames);
  layers.push({ label: item.phrase, color: colors[i % colors.length], hits });
  const events = packEvents(hits, parcel, { totalFrames: clip.frames });
  const v = verdict(events, item.expected);
  firstPass.push({ ...item, ...v, events });
  console.log(`  ${item.phrase}: expected ${item.expected}, net ${v.net} -> ${v.verdict}`);
}

const edges = layers.slice(1).flatMap((l) => trackEdges(l.hits, clip.frames));
const frames = annotatedFrames(clip.file, layers, pickFrames(clip.frames, fps, edges), fps);
const spark = await sparkVerdict(frames, items, fps);
console.log(`\nMuse Spark (${frames.length} frames): ${spark.summary}`);
for (const s of spark.steps) console.log(`  ${s.seconds.toFixed(1)}s  frame ${s.frame}  ${s.what}`);
for (const c of spark.counts) console.log(`  ${c.item}: expected ${c.expected}, seen in ${c.seen_in}`);
console.log(`\nPARCEL: ${spark.verdict.toUpperCase()}`);

fs.mkdirSync('data/checks', { recursive: true });
fs.writeFileSync(`data/checks/${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  JSON.stringify({ clip: clipPath, fps, frames: clip.frames, firstPass, spark }, null, 2));
