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
import { execFileSync } from 'node:child_process';
import { prepareClip, segment, trackObject, type Hit } from '../src/sam.js';
import { closeups, framesFor, packEvents, parcelTrack, pickFrames, trackEdges, trackEvents, verdict, type PackEvent, type Verdict } from '../src/events.js';
import { annotatedFrames, crops, detectionsOn, sparkVerdict, tag, type AgentContext, type Expected, type Layer, type Need } from '../src/spark.js';

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

const detectors = layers.map((l) => l.label);
const rounds: { round: number; sent: number; added: number[]; closeups: number; need: Need[]; spark_verdict: Verdict; verdict: Verdict; summary: string }[] = [];
let spark: Awaited<ReturnType<typeof sparkVerdict>>;
let frames: { frame: number; file: string }[];
if (!args.includes('--agent')) {
  const edges = layers.slice(1).flatMap((l) => trackEdges(l.hits, clip.frames));
  frames = annotatedFrames(clip.file, layers, pickFrames(clip.frames, fps, edges), fps);
  for (const [i, item] of items.entries()) if (item.image) item.closeups = crops(clipPath, closeups(itemHits[i]), fps);
  spark = await sparkVerdict(frames, items, detectors, fps);
} else {
  // Agent mode: start from one frame per second and SAM's track events as text;
  // Muse Spark asks for the frames or close-ups it needs, up to 3 rounds.
  const samEvents = layers.flatMap((l) => trackEvents(l.label, l.hits, clip.frames));
  frames = annotatedFrames(clip.file, layers, pickFrames(clip.frames, fps, []), fps);
  for (const [i, item] of items.entries()) if (item.image) item.closeups = crops(clipPath, closeups(itemHits[i], 1), fps);
  const asked: string[] = [];
  let candidates: AgentContext['candidates'];
  let added: number[] = [];
  let addedCloseups = 0;
  let follows = 0;
  // SAM's frame size, for box prompts in its own pixel space.
  const [samW] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', clip.file]).toString().split(',').map(Number);
  for (let round = 1; ; round++) {
    spark = await sparkVerdict(frames, items, layers.map((l) => l.label), fps, { round, totalFrames: clip.frames, samEvents, asked, candidates });
    candidates = spark.candidates;
    rounds.push({ round, sent: frames.length, added, closeups: addedCloseups, need: spark.need, spark_verdict: spark.spark_verdict, verdict: spark.verdict, summary: spark.summary });
    console.log(`round ${round}: ${frames.length} frames -> ${spark.verdict.toUpperCase()}${spark.need.map((n) => `\n  asks for ${n.kind} ${n.from_frame}-${n.to_frame}${n.detection ? ` ${n.detection}` : ''}: ${n.reason}`).join('')}`);
    if (!spark.need.length || round === 3) break;
    added = [];
    addedCloseups = 0;
    let followed = false;
    for (const n of spark.need) {
      if (n.kind === 'frames') added.push(...framesFor(n, clip.frames, [...frames.map((f) => f.frame), ...added]));
      else if (n.kind === 'follow') {
        // Muse Spark picked one detection; SAM 3.1 re-tracks that single object
        // with a box prompt, so spare stock of the same kind drops out.
        const det = detectionsOn(layers, n.from_frame).find((d) => d.name === n.detection.trim().toUpperCase());
        if (!det || follows >= 2) { asked.push(`follow ${n.detection} at frame ${n.from_frame} (${det ? 'limit reached' : 'no such box'})`); continue; }
        follows++;
        const base = layers[det.layer].label;
        const hits = await trackObject(clip.media, { width: samW, height: 720 }, n.from_frame, det.hit.box, clip.frames, `follow-${path.parse(clipPath).name}-${n.detection}-f${n.from_frame}`);
        layers.push({ label: `followed ${base}`, color: 'yellow', hits });
        const seen = [...new Set(hits.map((h) => h.frame))].sort((a, b) => a - b);
        if (seen.length) {
          const first = seen[0], last = seen.at(-1)!;
          samEvents.push(`the followed ${base} (${n.detection} on frame ${n.from_frame}, now tag ${tag(layers.length - 1)}) was tracked as one object from frame ${first} to frame ${last}; last seen at frame ${last}`);
          added.push(...framesFor({ from_frame: last - 3, to_frame: last + 1 }, clip.frames, [...frames.map((f) => f.frame), ...added], 5));
        } else samEvents.push(`following ${n.detection} on frame ${n.from_frame} found no object`);
        console.log(`  SAM followed ${n.detection} from frame ${n.from_frame}: frames ${seen[0]}-${seen.at(-1)}`);
        followed = true;
      } else for (const [i, item] of items.entries()) {
        if (!item.image) continue;
        const inRange = itemHits[i].filter((h) => h.frame >= Math.min(n.from_frame, n.to_frame) && h.frame <= Math.max(n.from_frame, n.to_frame));
        const more = crops(clipPath, closeups(inRange, 2, 3), fps).filter((f) => !(item.closeups ?? []).includes(f));
        item.closeups = [...(item.closeups ?? []), ...more].slice(0, 4);
        addedCloseups += more.length;
      }
      asked.push(n.kind === 'follow' ? `follow ${n.detection} on frame ${n.from_frame} (${n.reason})` : `${n.kind} ${n.from_frame}-${n.to_frame} (${n.reason})`);
    }
    if (!added.length && !addedCloseups && !followed) break;
    frames = [...frames, ...annotatedFrames(clip.file, layers, added, fps)].sort((a, b) => a.frame - b.frame);
  }
}
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
  JSON.stringify({ clip: clipPath, fps, frames: clip.frames, firstPass, rounds, spark }, null, 2));
