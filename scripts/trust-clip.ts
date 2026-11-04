// "Packed for you": a short vertical clip of the customer's exact item being
// packed, sent before a cash-on-delivery parcel arrives so the door is not a coin toss.
//
//   pnpm exec tsx scripts/trust-clip.ts <clip> <receipt.json> --follow-run <saved SAM follow run> --out <out.mp4>
//
// 1. Cuts from just before the item is first held to just after its container is in the box.
// 2. Spotlights the followed item with its own SAM 3.1 masks (no new SAM calls).
// 3. Asks Muse Spark 1.3 for one factual sentence about what was checked and packed.
// 4. Writes a 1080x1920 mp4 plus a JSON with the caption and timings beside it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { parseVideoStream, recordsOfKind, decodeMaskToRaster, frameIndexOf } from '@meta-sam/parser';
import { meta, spend, assertModel, PRICE } from '../src/meta.js';

const args = process.argv.slice(2);
const [clipPath, receiptPath] = args;
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const runPath = opt('follow-run');
const out = opt('out');
if (!clipPath || !receiptPath || !runPath || !out) throw new Error('usage: trust-clip.ts <clip> <receipt.json> --follow-run <run.txt> --out <out.mp4>');

const fps = 5; // SAM frame k is about time k/5 s (see samLag)
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
const { followedFrom, lastSeen, containerInParcelAt, container } = receipt.custody as
  { followedFrom: number; lastSeen: number; containerInParcelAt: number; container: string };

// The clip must be the one the receipt hashed, or the sha line would be a lie.
const sha = crypto.createHash('sha256').update(fs.readFileSync(clipPath)).digest('hex');
if (sha !== receipt.sha256) throw new Error(`${clipPath} sha256 ${sha} does not match the receipt (${receipt.sha256})`);

const probe = (file: string, entries: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim();
const [W, H] = probe(clipPath, 'stream=width,height').split(',').map(Number);
const clipSeconds = Number(probe(clipPath, 'format=duration').split(',')[0]);
// ffmpeg's fps=5 (round=near) keeps the LAST source frame of each 0.2 s slot, so SAM frame k
// shows source time k/5 + 0.1 s minus one source frame. Without this the mask runs ahead of the item.
const [num, den] = probe(clipPath, 'stream=r_frame_rate').split('/').map(Number);
const samLag = 1 / (2 * fps) - (den || 1) / num;

// --- 1. Timings: 1 s before the first clear hold to 1.5 s after the container is in the box, max 9 s.
const MAX = 9, KEEP = 2; // seconds kept at real speed at each end
const start = Math.max(0, followedFrom / fps - 1);
const end = Math.min(clipSeconds, containerInParcelAt / fps + 1.5);
const fast = end - start > MAX;
const speed = fast ? (end - start - 2 * KEEP) / (MAX - 2 * KEEP) : 1;
const segments = fast
  ? [{ from: start, to: start + KEEP, speed: 1 }, { from: start + KEEP, to: end - KEEP, speed }, { from: end - KEEP, to: end, speed: 1 }]
  : [{ from: start, to: end, speed: 1 }];

// --- 2. Masks of the followed object from the saved run (same replay as scripts/render-masks.ts).
type Mask = { frame: number; x: number; y: number; w: number; h: number; bits: Uint8Array };
const runText = fs.readFileSync(runPath, 'utf8');
const sw = Number(runText.match(/;w=(\d+);h=720/)?.[1]);
if (!Number.isFinite(sw)) throw new Error('cannot read SAM frame width from the follow run');
const sh = 720;
const lines = runText.split(/(?=<\d+f>)/).filter((l) => l.trim());
const lane = { item_id: 'saved', output_index: 0, content_index: 0 };
async function* events() {
  for (const l of lines) yield { type: 'response.output_text.delta', ...lane, delta: l.trim() + '\n' };
  yield { type: 'response.output_text.done', ...lane, text: lines.map((l) => l.trim() + '\n').join('') };
  yield { type: 'response.completed' };
}
const parsed = await parseVideoStream(events() as never).finalResult;
// Only the frames the receipt says the item itself was seen; later hits are the pouch or noise.
const masks = new Map<number, Mask>();
for (const m of recordsOfKind(parsed.records, 'mask')) {
  const frame = frameIndexOf(m) ?? 0;
  if (frame > lastSeen || masks.has(frame)) continue;
  masks.set(frame, { frame, x: Math.round(m.bounds.left), y: Math.round(m.bounds.top), w: m.mask.width, h: m.mask.height, bits: decodeMaskToRaster(m.mask) });
}
if (!masks.size) throw new Error('no item masks in the follow run');
const maskFrames = [...masks.keys()].sort((a, b) => a - b);
const box = (m: Mask) => [m.x, m.y, m.x + m.w, m.y + m.h];

// Per SAM frame: which mask to show and how strongly. Short gaps (<= 1 s) are bridged at full
// strength; beyond the last (or before the first) mask the darkening fades out over 1 s.
const FADE = 5;
function spotlightAt(k: number): { mask: Mask; strength: number } | null {
  const prev = maskFrames.filter((f) => f <= k).at(-1);
  const next = maskFrames.find((f) => f >= k);
  if (prev !== undefined && next !== undefined && next - prev <= FADE) return { mask: masks.get(k - prev <= next - k ? prev : next)!, strength: 1 };
  const near = prev !== undefined && (next === undefined || k - prev <= next - k) ? prev : next!;
  const strength = Math.max(0, 1 - Math.abs(k - near) / FADE);
  return strength > 0 ? { mask: masks.get(near)!, strength } : null;
}

// --- 3. Caption from Muse Spark 1.3 (cached per clip so re-renders cost nothing).
type Caption = { caption: string };
const cacheFile = `data/cache/trust-caption-${sha.slice(0, 12)}.json`;
// Three close-ups of the item: the largest mask in each third of its visible span.
const span = maskFrames.filter((f) => f >= followedFrom);
const thirds = [0, 1, 2].map((i) => span.slice(Math.floor((i * span.length) / 3), Math.floor(((i + 1) * span.length) / 3)));
const picks = thirds.map((t) => t.reduce((a, b) => (masks.get(b)!.bits.reduce((s, v) => s + v, 0) > masks.get(a)!.bits.reduce((s, v) => s + v, 0) ? b : a)));
const tmpDir = 'data/tmp/trust-clip';
fs.mkdirSync(tmpDir, { recursive: true });
const sx = W / sw, sy = H / sh;
const frameFiles = picks.map((k) => {
  const [x1, y1, x2, y2] = box(masks.get(k)!);
  const side = Math.min(H, Math.round(Math.max(x2 - x1, y2 - y1) * sx * 1.8));
  const cx = ((x1 + x2) / 2) * sx, cy = ((y1 + y2) / 2) * sy;
  const cx0 = Math.round(Math.min(Math.max(0, cx - side / 2), W - side)), cy0 = Math.round(Math.min(Math.max(0, cy - side / 2), H - side));
  const file = `${tmpDir}/item-f${k}.jpg`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', (k / fps + samLag).toFixed(3), '-i', clipPath, '-frames:v', '1', '-vf', `crop=${side}:${side}:${cx0}:${cy0},scale=512:512`, '-q:v', '3', file]);
  return file;
});

async function writeCaption(): Promise<Caption> {
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const model = 'muse-spark-1.3';
  assertModel(model, { customerData: false }); // product-only frames: hands and the item, no faces
  const packed = [container, 'gift box', ...(receipt.scan as string[]).filter((s) => /card/.test(s)).map(() => 'care card')];
  const prompt = [
    `These are close-ups of one ${receipt.scan[0].replace(/^\d+ x /, '')} from our packing bench camera, filmed from above while it was being packed for a customer's order.`,
    `It was then packed into: ${packed.join(', ')}.`,
    'Write caption: one warm, factual sentence to the customer about what we checked (its colour and finish, as you see them in these frames) and what it was packed in.',
    'Under 18 words. No promises, no brand names, no dashes, no emoji. Plain words a shopper in India would use.',
  ].join('\n');
  const estimate = (frameFiles.length * 1000 + 1500) * PRICE.sparkIn + 1500 * PRICE.sparkOut;
  const res = await spend(estimate, 'spark:trust_caption', () => meta.responses.create({
    model,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt },
      ...frameFiles.map((f) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}` }))] }] as never,
    text: { format: { type: 'json_schema', name: 'trust_caption', strict: true,
      schema: { type: 'object', additionalProperties: false, required: ['caption'], properties: { caption: { type: 'string' } } } } },
    reasoning: { effort: 'low' },
  } as never));
  const text = (res as { output_text?: string }).output_text ?? '';
  if (!text.trim()) throw new Error('Muse Spark returned no caption');
  const result = JSON.parse(text) as Caption;
  fs.mkdirSync('data/cache', { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}
const { caption } = await writeCaption();
const words = caption.trim().split(/\s+/).length;
if (/[–—]/.test(caption) || words >= 18) throw new Error(`caption breaks the rules (${words} words): ${caption}`);

// --- 4. Render. Text goes in files so drawtext needs no escaping.
const font = '/usr/share/fonts/opentype/sourcesans3/SourceSans3-Semibold.otf';
const fontLight = '/usr/share/fonts/opentype/sourcesans3/SourceSans3-Regular.otf';
function wrap(text: string, max: number): string[] {
  const rows: string[] = [];
  for (const w of text.split(/\s+/)) {
    if (rows.length && (rows.at(-1)! + ' ' + w).length <= max) rows[rows.length - 1] += ' ' + w;
    else rows.push(w);
  }
  return rows;
}
const textFile = (name: string, s: string) => { const f = `${tmpDir}/${name}.txt`; fs.writeFileSync(f, s); return f; };
const captionRows = wrap(caption, 34);

// Portrait 4:5 crop of the source that pans with the item (smoothed over 2 s), then settles on
// the bench centre once the item is in its container. Scaled to the phone width.
const OW = 1080, OH = 1920, VH = 1350, VY = 250;
const cropW = Math.min(W, Math.round((H * OW) / VH / 2) * 2);
const k0 = Math.floor(start * fps), k1 = Math.ceil(end * fps) + 1;
const centres = Array.from({ length: k1 - k0 + 1 }, (_, i) => {
  const spot = spotlightAt(k0 + i);
  if (!spot || k0 + i > lastSeen) return W / 2;
  const [x1, , x2] = box(spot.mask);
  return ((x1 + x2) / 2) * sx;
});
const panX = centres.map((_, i) => {
  const win = centres.slice(Math.max(0, i - 5), i + 6);
  return Math.min(Math.max(0, win.reduce((a, b) => a + b, 0) / win.length - cropW / 2), W - cropW);
});
// Piecewise-linear x(t) as a sum of one-frame pieces (no deep if() nesting for ffmpeg's parser).
const panExpr = panX.slice(0, -1).map((x, i) => {
  const t0 = +((k0 + i) / fps + samLag).toFixed(4);
  return `gte(t,${t0})*lt(t,${t0 + 1 / fps})*(${x.toFixed(1)}+${((panX[i + 1] - x) * fps).toFixed(2)}*(t-${t0}))`;
}).join('+');

const draw = (file: string, f: string, size: number, color: string, y: number) =>
  `drawtext=fontfile=${f}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}`;
const texts = [
  draw(textFile('title', 'Your order is packed'), font, 84, 'white', 104),
  ...captionRows.map((r, i) => draw(textFile(`caption-${i}`, r), font, 50, '0xF5EFE6', VY + VH + 52 + i * 64)),
  draw(textFile('sha', `Packing video sha256 ${sha.slice(0, 12)}`), fontLight, 30, '0xF5EFE6@0.55', OH - 76),
];
const segFilters = segments.map((s, i) =>
  `[s${i}]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed.toFixed(4)}[g${i}]`);
const filter = [
  // Mask stream: top half = darkening, bottom half = outline, one 5 fps frame per SAM frame.
  `[1:v]setpts=PTS+${samLag.toFixed(4)}/TB,split[mt][mb]`,
  `[mt]crop=${sw}:${sh}:0:0,gblur=sigma=5,scale=${W}:${H}:flags=bilinear,framerate=fps=60:scene=100[dark]`,
  `[mb]crop=${sw}:${sh}:0:${sh},gblur=sigma=0.8,scale=${W}:${H}:flags=bilinear,framerate=fps=60:scene=100[line]`,
  `color=black:s=${W}x${H}:r=60[k]`, `color=0xFFB547:s=${W}x${H}:r=60[warm]`,
  `[k][dark]alphamerge[shade]`, `[warm][line]alphamerge[rim]`,
  `[0:v]fps=60,format=yuv420p[v]`, `[v][shade]overlay=shortest=1[v1]`, `[v1][rim]overlay=shortest=1[lit]`,
  `[lit]crop=w=${cropW}:h=${H}:x='${panExpr}':y=0,split=${segments.length}${segments.map((_, i) => `[s${i}]`).join('')}`,
  ...segFilters,
  `${segments.map((_, i) => `[g${i}]`).join('')}concat=n=${segments.length}:v=1:a=0,fps=30,` +
    `scale=${OW}:${VH}:flags=lanczos,pad=${OW}:${OH}:0:${VY}:color=0x16120F,${texts.join(',')},format=yuv420p[out]`,
].join(';');

fs.mkdirSync(path.dirname(out), { recursive: true });
const samFrames = Math.ceil(clipSeconds * fps);
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', clipPath,
  '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${sw}x${sh * 2}`, '-r', String(fps), '-i', '-',
  '-filter_complex', filter, '-map', '[out]', '-an', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
{ stdio: ['pipe', 'inherit', 'inherit'] });
ff.stdin.on('error', () => {}); // ffmpeg died early; `done` says why
const done = new Promise((res, rej) => ff.on('close', (c, sig) => (c === 0 ? res(null) : rej(new Error(`ffmpeg exited ${c ?? sig}`)))));
done.catch(() => {});
const DIM = 0.6;
for (let k = 0; k < samFrames && ff.exitCode === null; k++) {
  const img = new Uint8Array(sw * sh * 2);
  const spot = spotlightAt(k);
  if (spot) {
    const { mask: m, strength } = spot;
    img.fill(Math.round(255 * DIM * strength), 0, sw * sh);
    const on = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < m.w && yy < m.h && m.bits[yy * m.w + xx] !== 0;
    // Pad one pixel around the mask so outer edge pixels get an outline too.
    for (let yy = -1; yy <= m.h; yy++) for (let xx = -1; xx <= m.w; xx++) {
      const X = m.x + xx, Y = m.y + yy;
      if (X < 0 || Y < 0 || X >= sw || Y >= sh) continue;
      const inside = on(xx, yy);
      if (inside) img[Y * sw + X] = 0;
      // A two-pixel rim straddling the mask boundary.
      if (inside !== on(xx - 1, yy) || inside !== on(xx + 1, yy) || inside !== on(xx, yy - 1) || inside !== on(xx, yy + 1)) {
        img[sw * sh + Y * sw + X] = Math.round(230 * strength);
      }
    }
  }
  if (!ff.stdin.write(img)) await Promise.race([new Promise((res) => ff.stdin.once('drain', res)), done.catch(() => {})]);
}
ff.stdin.end();
await done;

const duration = Number(probe(out, 'format=duration').split(',')[0]);
const summary = {
  clip: path.basename(clipPath), sha256: sha, caption, captionModel: 'muse-spark-1.3', captionFrames: picks,
  window: { start: +start.toFixed(2), end: +end.toFixed(2), sourceSeconds: +(end - start).toFixed(2) },
  segments: segments.map((s) => ({ from: +s.from.toFixed(2), to: +s.to.toFixed(2), speed: +s.speed.toFixed(2) })),
  spotlight: { followRun: path.basename(runPath), maskFrames: [maskFrames[0], maskFrames.at(-1)], fadeSeconds: FADE / fps, dim: DIM },
  output: { file: path.basename(out), width: OW, height: OH, seconds: +duration.toFixed(2) },
};
fs.writeFileSync(out.replace(/\.mp4$/, '.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`${out} ${duration.toFixed(2)} s, caption: ${caption}`);
