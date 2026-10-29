// SAM 3.1 over the Meta Model API: prepare a clip, segment one noun phrase,
// parse the per-frame boxes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { meta, spend, PRICE } from './meta.js';

export type Box = [number, number, number, number]; // x1, y1, x2, y2 in clip pixels
export type Hit = { frame: number; id: number; box: Box; c: number };
export type Media = Record<string, string>;

const dataUrl = (file: string, mime: string) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

// Video is billed per frame, so clips are downsampled (default 5 fps, 720p) before upload.
export function prepareClip(src: string, fps = 5): { media: Media; frames: number; file: string } {
  fs.mkdirSync('data/tmp', { recursive: true });
  const file = path.join('data/tmp', `${path.parse(src).name}-${fps}fps.mp4`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `fps=${fps},scale=-2:720`,
    '-c:v', 'libx264', '-an', '-movflags', '+faststart', file]);
  // ffprobe can print "100," (a trailing field separator), so parse the leading integer.
  const frames = parseInt(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).toString(), 10);
  if (!Number.isFinite(frames) || frames <= 0) throw new Error(`could not count frames in ${file}`);
  return { media: { type: 'input_video', video_url: dataUrl(file, 'video/mp4') }, frames, file };
}

export function imageMedia(src: string): Media {
  if (/^https?:\/\//.test(src)) return { type: 'input_image', image_url: src };
  return { type: 'input_image', image_url: dataUrl(src, src.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg') };
}

export function samCost(frames: number | null) {
  return frames === null ? PRICE.samImage : Math.max(PRICE.samMinFrames, frames) * PRICE.samFrame;
}

// One line per frame: <Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|><|mask;...|>,id<|box...
export function parseHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const line of text.split('\n')) {
    const frame = line.match(/^<(\d+)f>/);
    if (!frame) continue;
    for (const m of line.matchAll(/(\d+)<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=\d+;h=\d+(?:;c=([\d.]+))?\|>/g)) {
      hits.push({ frame: +frame[1], id: +m[1], box: [+m[2], +m[3], +m[4], +m[5]], c: m[6] ? +m[6] : NaN });
    }
  }
  return hits;
}

// Runs one phrase and saves the raw wire text to data/runs/ for later analysis.
export async function segment(media: Media, phrase: string, frames: number | null): Promise<Hit[]> {
  const text = await spend(samCost(frames), `sam:${phrase}`, async () => {
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
  fs.mkdirSync('data/runs', { recursive: true });
  fs.writeFileSync(`data/runs/${new Date().toISOString().replace(/[:.]/g, '-')}-${phrase.replace(/\W+/g, '_')}.txt`, text);
  return parseHits(text);
}
