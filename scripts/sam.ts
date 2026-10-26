// Day-1 test tool. Runs SAM 3.1 on one image or clip for one noun phrase and
// reports what it tracked: frames with a match, object ids, when each id
// appears and disappears, and the most objects seen at once.
//
//   pnpm sam <image|clip|url> "<noun phrase>" [--fps 5]
//
// Clips are downsampled with ffmpeg first (default 5 fps, 720p) because video
// is billed per frame. Raw lines are saved to data/runs/ for later analysis.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { meta, spend, PRICE } from '../src/meta.js';

const [src, phrase] = process.argv.slice(2);
const fps = Number(process.argv[process.argv.indexOf('--fps') + 1] || 5);
if (!src || !phrase) throw new Error('usage: pnpm sam <image|clip|url> "<noun phrase>" [--fps 5]');

const isVideo = /\.(mov|mp4|m4v)$/i.test(src);
const isUrl = /^https?:\/\//.test(src);

function prepareClip(file: string): { path: string; frames: number } {
  fs.mkdirSync('data/tmp', { recursive: true });
  const out = path.join('data/tmp', `${path.parse(file).name}-${fps}fps.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vf', `fps=${fps},scale=-2:720`,
    '-c:v', 'libx264', '-an', '-movflags', '+faststart', out]);
  const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out]).toString().trim());
  return { path: out, frames };
}

function dataUrl(file: string, mime: string) {
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

let media: Record<string, string>;
let estimate: number;
if (isVideo) {
  const clip = prepareClip(src);
  media = { type: 'input_video', video_url: dataUrl(clip.path, 'video/mp4') };
  estimate = Math.max(PRICE.samMinFrames, clip.frames) * PRICE.samFrame;
  console.log(`clip: ${clip.frames} frames at ${fps} fps, est $${estimate.toFixed(4)}`);
} else {
  const mime = src.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  media = { type: 'input_image', image_url: isUrl ? src : dataUrl(src, mime) };
  estimate = PRICE.samImage;
}

const text = await spend(estimate, `sam:${phrase}`, async () => {
  const stream = await meta.responses.create({
    model: 'sam-3.1',
    // The SDK types only know OpenAI's own content parts; Meta adds input_video.
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: phrase }, media] }] as never,
    stream: true,
    metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
  });
  let out = '';
  for await (const event of stream) if (event.type === 'response.output_text.delta') out += event.delta + '\n';
  return out;
});

// One line per frame: <Nf>id<|box;...;c=..|><|mask;...|>,id<|box...
type Hit = { frame: number; id: number; box: number[]; c: number };
const hits: Hit[] = [];
for (const line of text.split('\n')) {
  const frame = line.match(/^<(\d+)f>/);
  if (!frame) continue;
  for (const m of line.matchAll(/(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=\d+;h=\d+(?:;c=([\d.]+))?\|>/g)) {
    hits.push({ frame: +frame[1], id: +m[1], box: [+m[2], +m[3], +m[4], +m[5]], c: m[6] ? +m[6] : NaN });
  }
}

fs.mkdirSync('data/runs', { recursive: true });
const runFile = `data/runs/${new Date().toISOString().replace(/[:.]/g, '-')}-${phrase.replace(/\W+/g, '_')}.txt`;
fs.writeFileSync(runFile, text);

const frames = new Set(hits.map((h) => h.frame));
const perFrame = [...frames].map((f) => hits.filter((h) => h.frame === f).length);
console.log(`"${phrase}": ${hits.length} detections on ${frames.size} frames, max ${Math.max(0, ...perFrame)} at once`);
for (const id of new Set(hits.map((h) => h.id))) {
  const mine = hits.filter((h) => h.id === id);
  const cs = mine.map((h) => h.c).filter((c) => !Number.isNaN(c));
  const avg = cs.length ? (cs.reduce((a, b) => a + b, 0) / cs.length).toFixed(2) : '?';
  console.log(`  id ${id}: frames ${mine[0].frame}-${mine.at(-1)!.frame} (${mine.length} seen), avg confidence ${avg}`);
}
console.log(`raw output: ${runFile}`);
