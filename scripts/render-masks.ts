// Draws SAM 3.1's pixel masks (not just boxes) back onto a bench clip.
//
//   pnpm exec tsx scripts/render-masks.ts <clip> <out.mp4> "cardboard box" "wallet" ["white printed card"]
//
// Uses the raw SAM output saved in data/runs/ by `pnpm check` (no new API calls),
// decodes each mask with Meta's @meta-sam/parser, and paints it over the clip.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { parseVideoStream, recordsOfKind, decodeMaskToRaster, frameIndexOf } from '@meta-sam/parser';
import { parseHits, type Hit } from '../src/sam.js';

const [clipPath, out, ...phrases] = process.argv.slice(2);
if (!clipPath || !out || !phrases.length) throw new Error('usage: render-masks.ts <clip> <out.mp4> <phrase>...');
const fps = 5;
// A "run:" layer (a single followed object) is drawn in yellow.
const palette: [number, number, number][] = [[59, 130, 246], [34, 197, 94], [249, 115, 22], [217, 70, 239]];
const colors = phrases.map((p, i): [number, number, number] => (p.startsWith('run:') ? [250, 204, 21] : palette[i % palette.length]));

// The saved raw run whose boxes match this clip's cached SAM hits for a phrase.
// "run:<file>" uses one saved run directly, e.g. a box-prompted follow track.
function rawRunFor(phrase: string): string {
  if (phrase.startsWith('run:')) return fs.readFileSync(phrase.slice(4), 'utf8');
  const slug = phrase.replace(/\W+/g, '_');
  const cache = fs.readdirSync('data/cache').find((n) => n.startsWith(path.parse(clipPath).name) && n.endsWith(`-5-${slug}.json`));
  if (!cache) throw new Error(`no cached SAM hits for "${phrase}" on ${clipPath}`);
  const hits: Hit[] = JSON.parse(fs.readFileSync(`data/cache/${cache}`, 'utf8'));
  const key = (h: Hit[]) => JSON.stringify(h.slice(0, 3).map((x) => [x.frame, x.box]));
  for (const f of fs.readdirSync('data/runs').filter((n) => n.endsWith(`-${slug}.txt`))) {
    const text = fs.readFileSync(`data/runs/${f}`, 'utf8');
    if (key(parseHits(text)) === key(hits)) return text;
  }
  throw new Error(`no saved raw SAM run matches the cache for "${phrase}"`);
}

type Mask = { frame: number; x: number; y: number; w: number; h: number; bits: Uint8Array };
async function masksFor(phrase: string): Promise<Mask[]> {
  const text = rawRunFor(phrase);
  const lines = text.split(/(?=<\d+f>)/).filter((l) => l.trim());
  // Replay the saved wire text as the Responses events the parser expects.
  const lane = { item_id: 'saved', output_index: 0, content_index: 0 };
  async function* events() {
    for (const l of lines) yield { type: 'response.output_text.delta', ...lane, delta: l.trim() + '\n' };
    yield { type: 'response.output_text.done', ...lane, text: lines.map((l) => l.trim() + '\n').join('') };
    yield { type: 'response.completed' };
  }
  const result = await parseVideoStream(events() as never).finalResult;
  return recordsOfKind(result.records, 'mask').map((m) => ({
    frame: frameIndexOf(m) ?? 0, x: Math.round(m.bounds.left), y: Math.round(m.bounds.top),
    w: m.mask.width, h: m.mask.height, bits: decodeMaskToRaster(m.mask),
  }));
}

const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', clipPath])
  .toString().split(',').map((s) => parseInt(s, 10));
// SAM's frame size, as it reports on every box.
const firstRun = rawRunFor(phrases[0]);
const [, swText] = firstRun.match(/;w=(\d+);h=720/) ?? [];
const sw = Number(swText);
if (!Number.isFinite(sw)) throw new Error('cannot read SAM frame width from the saved run');
const layers = await Promise.all(phrases.map(masksFor));
const frames = parseInt(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0',
  `data/tmp/${path.parse(clipPath).name}-${fps}fps.mp4`]).toString(), 10);

// One RGBA overlay per 5 fps frame at SAM's resolution: translucent fill, solid outline.
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', clipPath,
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${sw}x720`, '-r', String(fps), '-i', '-',
  '-filter_complex', `[1:v]format=rgba,scale=${W}:${H}:flags=bilinear,fps=30[m];[0:v]fps=30,format=yuva420p[v];[v][m]overlay=format=auto:shortest=1,format=yuv420p`,
  '-an', '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
for (let f = 0; f < frames; f++) {
  const img = new Uint8Array(sw * 720 * 4);
  layers.forEach((masks, li) => {
    const [r, g, b] = colors[li % colors.length];
    for (const m of masks.filter((x) => x.frame === f)) {
      for (let yy = 0; yy < m.h; yy++) for (let xx = 0; xx < m.w; xx++) {
        if (!m.bits[yy * m.w + xx]) continue;
        const X = m.x + xx, Y = m.y + yy;
        if (X < 0 || Y < 0 || X >= sw || Y >= 720) continue;
        const edge = xx === 0 || yy === 0 || xx === m.w - 1 || yy === m.h - 1 ||
          !m.bits[yy * m.w + xx - 1] || !m.bits[yy * m.w + xx + 1] || !m.bits[(yy - 1) * m.w + xx] || !m.bits[(yy + 1) * m.w + xx];
        const p = (Y * sw + X) * 4;
        img[p] = r; img[p + 1] = g; img[p + 2] = b; img[p + 3] = edge ? 235 : 95;
      }
    }
  });
  if (!ff.stdin.write(img)) await new Promise((res) => ff.stdin.once('drain', res));
}
ff.stdin.end();
await new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res(null) : rej(new Error(`ffmpeg exited ${c}`)))));
console.log(out, layers.map((m, i) => `${phrases[i]}: ${m.length} masks`).join(', '));
