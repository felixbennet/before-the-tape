// Muse Spark reads a strip of frames with SAM's boxes drawn on them and works
// out what happened, including nesting (wallet into pouch, pouch into box),
// citing the frames that show each step. It also picks which catalogue photo,
// out of the scanned product and look-alike variants, shows the packed item.
// The final verdict is decided in code from what Spark reports.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { meta, spend, assertModel, PRICE } from './meta.js';
import type { Hit } from './sam.js';
import type { Verdict } from './events.js';

export type Layer = { label: string; color: string; hits: Hit[] };
export type SparkStep = { frame: number; seconds: number; what: string };
export type Identity = 'yes' | 'no' | 'unclear' | 'no_reference';
export type SparkCount = { item: string; expected: number; seen_in: number; reference_pick: number; reference_note: string };
export type SparkRaw = { verdict: Verdict; summary: string; steps: SparkStep[]; counts: SparkCount[] };
export type SparkResult = SparkRaw & { spark_verdict: Verdict; why: string[]; identity: Identity[] };

// Boxes carry a neutral tag (A, B, ...) instead of the prompt phrase, so a
// mislabelled box does not tell Spark what it is looking at.
export const tag = (i: number) => String.fromCharCode(65 + i);

// The chosen frames of the downsampled clip, with each layer's boxes and a time
// stamp burned in, scaled to 640 px wide to keep image tokens low.
export function annotatedFrames(clipFile: string, layers: Layer[], frameList: number[], fps: number): { frame: number; file: string }[] {
  const dir = path.join('data/frames', path.parse(clipFile).name);
  fs.mkdirSync(dir, { recursive: true });
  const out: { frame: number; file: string }[] = [];
  for (const f of frameList) {
    const draws = layers.flatMap((l, i) => l.hits.filter((h) => h.frame === f).map((h) => {
      const [x1, y1, x2, y2] = h.box;
      return `drawbox=x=${x1}:y=${y1}:w=${x2 - x1}:h=${y2 - y1}:color=${l.color}:t=5,` +
        `drawtext=text='${tag(i)}':x=${x1}:y=${Math.max(0, y1 - 26)}:fontsize=22:fontcolor=white:box=1:boxcolor=${l.color}`;
    }));
    const stamp = `drawtext=text='frame ${f}  ${(f / fps).toFixed(1)}s':x=10:y=10:fontsize=26:fontcolor=yellow:box=1:boxcolor=black`;
    const vf = [`select=eq(n\\,${f})`, ...draws, stamp, 'scale=640:-2'].join(',');
    const file = path.join(dir, `f${String(f).padStart(4, '0')}.jpg`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', clipFile, '-vf', vf, '-frames:v', '1', '-q:v', '4', file]);
    out.push({ frame: f, file });
  }
  return out;
}

// Full-resolution crops of the given boxes, cut from the source clip (SAM's
// boxes are in the 720 px high downsampled clip), with a 20% margin.
export function crops(srcFile: string, hits: Hit[], fps: number): string[] {
  const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', srcFile])
    .toString().split(',').map((s) => parseInt(s, 10));
  const k = h / 720;
  const dir = path.join('data/crops', path.parse(srcFile).name);
  fs.mkdirSync(dir, { recursive: true });
  return hits.map((hit) => {
    const [x1, y1, x2, y2] = hit.box.map((v) => v * k);
    const m = 0.2 * Math.max(x2 - x1, y2 - y1);
    const cx = Math.max(0, Math.round(x1 - m)), cy = Math.max(0, Math.round(y1 - m));
    const cw = Math.min(w - cx, Math.round(x2 - x1 + 2 * m)), ch = Math.min(h - cy, Math.round(y2 - y1 + 2 * m));
    const file = path.join(dir, `f${String(hit.frame).padStart(4, '0')}.jpg`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(hit.frame / fps), '-i', srcFile,
      '-vf', `crop=${cw}:${ch}:${cx}:${cy}`, '-frames:v', '1', '-q:v', '2', file]);
    return file;
  });
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'steps', 'counts'],
  properties: {
    verdict: { type: 'string', enum: ['consistent', 'mismatch', 'uncertain'] },
    summary: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['frame', 'seconds', 'what'],
      properties: { frame: { type: 'integer' }, seconds: { type: 'number' }, what: { type: 'string' } } } },
    counts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'expected', 'seen_in', 'reference_pick', 'reference_note'],
      properties: {
        item: { type: 'string' }, expected: { type: 'integer' }, seen_in: { type: 'integer' },
        reference_pick: { type: 'integer' }, reference_note: { type: 'string' },
      } } },
  },
};

// A scanned item. `image` is the catalogue photo of the scanned variant and
// `decoys` are photos of look-alike variants; each is a public URL or a local file.
// `closeups` are full-resolution crops of the item as it was handled.
export type Expected = { phrase: string; expected: number; product?: string; image?: string; decoys?: string[]; closeups?: string[] };
// The candidate photos in the order Spark sees them, and which one was scanned (1-based).
export type Candidates = { photos: string[]; answer: number };

export function shuffleCandidates(e: Expected, random = Math.random): Candidates | null {
  if (!e.image) return null;
  const photos = [e.image, ...(e.decoys ?? [])];
  for (let i = photos.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [photos[i], photos[j]] = [photos[j], photos[i]];
  }
  return { photos, answer: photos.indexOf(e.image) + 1 };
}

const imagePart = (src: string) => ({
  type: 'input_image',
  image_url: /^https?:\/\//.test(src) ? src : `data:image/jpeg;base64,${fs.readFileSync(src).toString('base64')}`,
});

// Spark observes; this decides. Consistent needs every link: cited frames that
// were really shown, counts equal to the scan, and the right variant picked.
export function decide(raw: SparkRaw, expected: Expected[], candidates: (Candidates | null)[], sent: number[], fps: number): SparkResult {
  const why: string[] = [];
  const steps = raw.steps.map((s) => ({ ...s, seconds: s.frame / fps }));
  for (const s of steps) if (!sent.includes(s.frame)) why.push(`cited frame ${s.frame}, which it was never shown`);
  if (raw.counts.length !== expected.length) why.push(`gave ${raw.counts.length} counts for ${expected.length} scanned items`);
  const identity = expected.map((_, i): Identity => {
    const c = raw.counts[i], cand = candidates[i];
    if (!cand) return 'no_reference';
    if (!c || c.reference_pick === 0) return 'unclear';
    return c.reference_pick === cand.answer ? 'yes' : 'no';
  });
  const countsMatch = expected.every((e, i) => raw.counts[i]?.seen_in === e.expected);
  let verdict: Verdict;
  if (why.length) verdict = 'uncertain';
  else if (identity.includes('no')) {
    verdict = 'mismatch';
    why.push(`packed ${expected[identity.indexOf('no')].phrase} is not the scanned variant`);
  } else if (raw.verdict === 'mismatch' && !countsMatch) verdict = 'mismatch';
  else if (raw.verdict === 'consistent' && countsMatch && !identity.includes('unclear')) verdict = 'consistent';
  else {
    verdict = 'uncertain';
    if (identity.includes('unclear')) why.push('could not tell which variant was packed');
    if (raw.verdict === 'consistent' && !countsMatch) why.push('said consistent but its counts differ from the scan');
    if (raw.verdict === 'mismatch' && countsMatch) why.push('said mismatch but its counts match the scan');
  }
  return { ...raw, steps, verdict, spark_verdict: raw.verdict, why, identity };
}

export async function sparkVerdict(frames: { frame: number; file: string }[], expected: Expected[], detectors: string[], fps: number): Promise<SparkResult & { candidates: (Candidates | null)[] }> {
  const model = 'muse-spark-1.3';
  assertModel(model, { customerData: false });
  const candidates = expected.map((e) => shuffleCandidates(e));
  const prompt = [
    'You are checking one parcel being packed at a warehouse bench, filmed from above.',
    `The frames below are in time order (source ${fps} frames per second); each is stamped with its frame number and seconds.`,
    'There is roughly one frame per second, with extra consecutive frames around the moments where the detector saw an item appear or vanish. Look closely at those runs: that is usually where an item goes into packaging.',
    `Coloured boxes are object detections from a segmentation model, tagged by what it was asked to find: ${detectors.map((d, i) => `${tag(i)} = "${d}"`).join(', ')}. They can miss objects or mark wrong ones; trust what you see in the image over the boxes.`,
    `The barcode scan says the parcel must contain: ${expected.map((e) => `${e.expected} x ${e.phrase}`).join(', ')}.`,
    'Packaging can be nested (for example an item goes into a cloth pouch, the pouch into a box). An item counts as packed if it ends up inside the final closed container, directly or inside inner packaging.',
    'Ignore spare stock lying elsewhere on the desk.',
    'Work out what went into the parcel and whether anything was taken back out before it was closed.',
    'Verdict (about packing only): "consistent" if what you saw go in matches the scan, "mismatch" if it clearly does not, "uncertain" if the frames do not show enough to tell. Never guess; prefer uncertain.',
    'In steps, cite the frame number for each thing you saw happen. Only cite frames you were shown.',
    'counts: one entry per scanned item, in scan-list order, item copied exactly. seen_in = how many of that item you saw end up inside the closed parcel.',
    'Some items come with numbered CANDIDATE PHOTOS from the catalogue: similar products that differ in colour, leather finish, stitching, hardware or where the branding sits. They also come with CLOSE-UPS of the item as it was handled, cut from the video at full resolution. Compare the close-ups (and the frames) with each candidate. Lighting and angle differ; judge the features you can actually see.',
    'reference_pick: the number of the candidate that is the same product as the one packed, 0 if the frames do not show enough to tell them apart, -1 if the packed item is none of them. Use 0 for items with no candidate photos. In reference_note, name the features you compared.',
  ].join('\n');
  const refs = expected.flatMap((e, i) => {
    const cand = candidates[i];
    if (!cand) return [];
    return [
      ...(e.closeups?.length ? [{ type: 'input_text', text: `CLOSE-UPS of the packed "${e.phrase}":` }, ...e.closeups.map(imagePart)] : []),
      { type: 'input_text', text: `CANDIDATE PHOTOS for "${e.phrase}":` },
      ...cand.photos.flatMap((p, k) => [{ type: 'input_text', text: `Candidate ${k + 1}:` }, imagePart(p)]),
    ];
  });
  const content = [
    { type: 'input_text', text: prompt },
    ...refs,
    { type: 'input_text', text: 'PACKING FRAMES, in time order:' },
    ...frames.map((f) => imagePart(f.file)),
  ];
  // ~1,000 image tokens per 640 px frame (and per candidate photo) plus the prompt; generous output for reasoning.
  const images = frames.length + candidates.reduce((n, c) => n + (c?.photos.length ?? 0), 0) + expected.reduce((n, e) => n + (e.image ? e.closeups?.length ?? 0 : 0), 0);
  const estimate = (images * 1000 + 2000) * PRICE.sparkIn + 6000 * PRICE.sparkOut;
  const res = await spend(estimate, 'spark:verdict', () => meta.responses.create({
    model,
    input: [{ type: 'message', role: 'user', content }] as never,
    text: { format: { type: 'json_schema', name: 'pack_check', schema: SCHEMA, strict: true } },
  } as never));
  const text = (res as { output_text?: string }).output_text ?? '';
  if (!text.trim()) throw new Error('Muse Spark returned no answer');
  const raw = JSON.parse(text) as SparkRaw;
  return { ...decide(raw, expected, candidates, frames.map((f) => f.frame), fps), candidates };
}
