// Runs SAM 3.1 on one image or clip for one noun phrase and reports what it
// tracked: frames with a match, object ids, when each id appears and
// disappears, and the most objects seen at once.
//
//   pnpm sam <image|clip|url> "<noun phrase>" [--fps 5]
import { prepareClip, imageMedia, segment, samCost } from '../src/sam.js';

const [src, phrase] = process.argv.slice(2);
const fps = Number(process.argv[process.argv.indexOf('--fps') + 1] || 5);
if (!src || !phrase) throw new Error('usage: pnpm sam <image|clip|url> "<noun phrase>" [--fps 5]');

const isVideo = /\.(mov|mp4|m4v)$/i.test(src);
const clip = isVideo ? prepareClip(src, fps) : null;
if (clip) console.log(`clip: ${clip.frames} frames at ${fps} fps, est $${samCost(clip.frames).toFixed(4)}`);
const hits = await segment(clip ? clip.media : imageMedia(src), phrase, clip ? clip.frames : null);

const frames = new Set(hits.map((h) => h.frame));
const perFrame = [...frames].map((f) => hits.filter((h) => h.frame === f).length);
console.log(`"${phrase}": ${hits.length} detections on ${frames.size} frames, max ${Math.max(0, ...perFrame)} at once`);
for (const id of new Set(hits.map((h) => h.id))) {
  const mine = hits.filter((h) => h.id === id);
  const cs = mine.map((h) => h.c).filter((c) => !Number.isNaN(c));
  const avg = cs.length ? (cs.reduce((a, b) => a + b, 0) / cs.length).toFixed(2) : '?';
  console.log(`  id ${id}: frames ${mine[0].frame}-${mine.at(-1)!.frame} (${mine.length} seen), avg confidence ${avg}`);
}
