// Custody receipt for one packed parcel: the evidence a marketplace or courier
// claim actually asks for, in one proof image under 2 MB.
//
//   pnpm receipt <clip> <check.json> [--item wallet] [--container "cloth pouch"]
//
// 1. Continuity: one unbroken take (no timestamp gaps, no scene cuts).
// 2. Custody: SAM 3.1 follows the exact item the packer handled (a box prompt on
//    its clearest frame), then the container it vanished into, until that
//    container is inside the parcel box.
// 3. The saved Muse Spark verdict and cited steps, and a SHA-256 of the clip.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { prepareClip, segment, trackObject, type Hit } from '../src/sam.js';
import { closeups, parcelTrack } from '../src/events.js';

const args = process.argv.slice(2);
const [clipPath, checkPath] = args;
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i === -1 ? dflt : args[i + 1]; };
const itemPhrase = opt('item', 'wallet');
const containerPhrase = opt('container', 'cloth pouch');
if (!clipPath || !checkPath) throw new Error('usage: pnpm receipt <clip> <check.json> [--item wallet] [--container "cloth pouch"]');
const fps = 5;
const check = JSON.parse(fs.readFileSync(checkPath, 'utf8'));

// 1. Continuity of the recorded take.
const pts = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', clipPath])
  .toString().split('\n').map((s) => parseFloat(s)).filter(Number.isFinite).sort((a, b) => a - b);
const gaps = pts.slice(1).map((t, i) => t - pts[i]);
const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
const maxGap = Math.max(...gaps);
// Scene cuts: frames whose content jumps (showinfo logs each selected frame to stderr).
const sceneLog = spawnSync('ffmpeg', ['-hide_banner', '-i', clipPath, '-vf', "select='gt(scene,0.45)',showinfo", '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const cutCount = (sceneLog.match(/pts_time:/g) ?? []).length;
const continuity = { frames: pts.length, seconds: +(pts.at(-1)! - pts[0] + median).toFixed(2), maxGapMs: Math.round(maxGap * 1000), cuts: cutCount,
  unbroken: maxGap < 3 * median && cutCount === 0 };

// 2. Custody with SAM 3.1 (cached per clip and prompt).
const clip = prepareClip(clipPath, fps);
const cacheFile = (key: string) => `data/cache/${path.parse(clipPath).name}-${fs.statSync(clipPath).mtimeMs}-${fps}-${key.replace(/\W+/g, '_')}.json`;
async function cached(key: string, run: () => Promise<Hit[]>): Promise<Hit[]> {
  const f = cacheFile(key);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  const hits = await run();
  fs.mkdirSync('data/cache', { recursive: true });
  fs.writeFileSync(f, JSON.stringify(hits));
  return hits;
}
const samW = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', clip.file]).toString().split(',')[0]);
const itemHits = await cached(itemPhrase, () => segment(clip.media, itemPhrase, clip.frames));
const seed = closeups(itemHits, 1)[0];
if (!seed) throw new Error(`no handled "${itemPhrase}" track to follow`);
const followed = await cached(`follow-${itemPhrase}-f${seed.frame}`, () =>
  trackObject(clip.media, { width: samW, height: 720 }, seed.frame, seed.box, clip.frames, `follow-${path.parse(clipPath).name}-${itemPhrase}-f${seed.frame}`));
const containerHits = await cached(containerPhrase, () => segment(clip.media, containerPhrase, clip.frames));
const parcel = parcelTrack(await cached('cardboard box', () => segment(clip.media, 'cardboard box', clip.frames)));

const center = (b: Hit['box']) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const inside = (b: Hit['box'], p: Hit['box']) => { const [x, y] = center(b); return x > p[0] && x < p[2] && y > p[1] && y < p[3]; };
const seenItem = [...new Set(followed.map((h) => h.frame))].sort((a, b) => a - b);
const lastSeen = seenItem.at(-1)!;
const lastBox = followed.filter((h) => h.frame === lastSeen)[0].box;
// The container the item vanished into: the container box nearest the item's last position.
const near = containerHits.filter((h) => Math.abs(h.frame - lastSeen) <= 2)
  .sort((a, b) => Math.hypot(...center(a.box).map((v, i) => v - center(lastBox)[i])) - Math.hypot(...center(b.box).map((v, i) => v - center(lastBox)[i])))[0];
// Follow the container frame by frame (nearest box to where it was) until it sits inside the parcel box.
let pos = near ? center(near.box) : center(lastBox);
let missing = 0, maxMissing = 0, inBoxAt: number | null = null;
for (let f = lastSeen; f < clip.frames && inBoxAt === null; f++) {
  const here = containerHits.filter((h) => h.frame === f).sort((a, b) => Math.hypot(...center(a.box).map((v, i) => v - pos[i])) - Math.hypot(...center(b.box).map((v, i) => v - pos[i])))[0];
  if (!here) { missing++; maxMissing = Math.max(maxMissing, missing); continue; }
  missing = 0;
  pos = center(here.box);
  const p = parcel?.(f);
  if (p && f > lastSeen && inside(here.box, p)) inBoxAt = f;
}
const custody = {
  followedFrom: seed.frame, itemVisible: [seenItem[0], lastSeen], lastSeen, container: containerPhrase,
  containerInParcelAt: inBoxAt, longestUnseenGapFrames: maxMissing,
  chained: inBoxAt !== null && maxMissing <= 4,
};

// 3. The receipt.
const sha = crypto.createHash('sha256').update(fs.readFileSync(clipPath)).digest('hex');
const receipt = { clip: path.basename(clipPath), sha256: sha, continuity, custody, scan: check.firstPass?.map((p: { phrase: string; expected: number }) => `${p.expected} x ${p.phrase}`),
  verdict: check.spark?.verdict, steps: check.spark?.steps };
fs.mkdirSync('data/receipts', { recursive: true });
const base = `data/receipts/${path.parse(clipPath).name}`;
fs.writeFileSync(`${base}.json`, JSON.stringify(receipt, null, 2));

// Proof image: four key frames and the facts, as one JPEG.
const keyFrames = [seed.frame, lastSeen, inBoxAt ?? lastSeen + 10, clip.frames - 1];
const lines = [
  `BeforeTheTape custody receipt  ${receipt.clip}  sha256 ${sha.slice(0, 16)}...`,
  `Scan: ${receipt.scan?.join(', ')}    Verdict: ${String(receipt.verdict).toUpperCase()}`,
  `Take: ${continuity.unbroken ? 'one unbroken take' : 'NOT unbroken'}, ${continuity.seconds} s, ${continuity.frames} frames, ${continuity.cuts} cuts, max gap ${continuity.maxGapMs} ms`,
  `Custody: SAM 3.1 followed the ${itemPhrase} (f${seed.frame} to f${lastSeen}) into the ${containerPhrase.split(' ').at(-1)}, ${custody.chained ? 'kept in view' : 'NOT kept in view'} until inside the box (f${inBoxAt ?? '?'})`,
];
const tmp = fs.mkdtempSync('/tmp/receipt-');
lines.forEach((l, i) => fs.writeFileSync(`${tmp}/l${i}.txt`, l));
const labels = [`in hand f${seed.frame}`, `into ${containerPhrase.split(' ').at(-1)} f${lastSeen}`, `in box f${inBoxAt ?? '?'}`, 'end of take'];
const inputs = keyFrames.flatMap((f) => ['-ss', String(f / fps + 0.1), '-i', clipPath]);
const tiles = keyFrames.map((_, i) => `[${i}:v]scale=480:360:force_original_aspect_ratio=increase,crop=480:360,drawtext=text='${labels[i]}':x=10:y=10:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.7[t${i}]`).join(';');
const text = lines.map((_, i) => `drawtext=textfile=${tmp}/l${i}.txt:x=20:y=${380 + i * 44}:fontsize=26:fontcolor=0x1b1a17`).join(',');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-frames:v', '1', '-filter_complex',
  `${tiles};${keyFrames.map((_, i) => `[t${i}]`).join('')}hstack=${keyFrames.length},pad=1920:560:0:0:color=0xf4f0e8,${text}`, '-q:v', '3', `${base}-proof.jpg`]);
const kb = Math.round(fs.statSync(`${base}-proof.jpg`).size / 1024);
console.log(JSON.stringify({ continuity, custody, verdict: receipt.verdict }, null, 2));
console.log(`${base}-proof.jpg (${kb} KB)`);
