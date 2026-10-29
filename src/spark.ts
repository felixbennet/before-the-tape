// Muse Spark reads a strip of frames with SAM's boxes drawn on them and works
// out what happened, including nesting (wallet into pouch, pouch into box),
// citing the frames that show each step.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { meta, spend, assertModel, PRICE } from './meta.js';
import type { Hit } from './sam.js';
import type { Verdict } from './events.js';

export type Layer = { label: string; color: string; hits: Hit[] };
export type SparkStep = { frame: number; seconds: number; what: string };
export type SparkResult = { verdict: Verdict; summary: string; steps: SparkStep[]; counts: { item: string; expected: number; seen_in: number }[] };

// The chosen frames of the downsampled clip, with each layer's boxes and a time
// stamp burned in, scaled to 640 px wide to keep image tokens low.
export function annotatedFrames(clipFile: string, layers: Layer[], frameList: number[], fps: number): { frame: number; file: string }[] {
  const dir = path.join('data/frames', path.parse(clipFile).name);
  fs.mkdirSync(dir, { recursive: true });
  const out: { frame: number; file: string }[] = [];
  for (const f of frameList) {
    const draws = layers.flatMap((l) => l.hits.filter((h) => h.frame === f).map((h) => {
      const [x1, y1, x2, y2] = h.box;
      return `drawbox=x=${x1}:y=${y1}:w=${x2 - x1}:h=${y2 - y1}:color=${l.color}:t=5,` +
        `drawtext=text='${l.label}':x=${x1}:y=${Math.max(0, y1 - 26)}:fontsize=22:fontcolor=white:box=1:boxcolor=${l.color}`;
    }));
    const stamp = `drawtext=text='frame ${f}  ${(f / fps).toFixed(1)}s':x=10:y=10:fontsize=26:fontcolor=yellow:box=1:boxcolor=black`;
    const vf = [`select=eq(n\\,${f})`, ...draws, stamp, 'scale=640:-2'].join(',');
    const file = path.join(dir, `f${String(f).padStart(4, '0')}.jpg`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', clipFile, '-vf', vf, '-frames:v', '1', '-q:v', '4', file]);
    out.push({ frame: f, file });
  }
  return out;
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
    counts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'expected', 'seen_in'],
      properties: { item: { type: 'string' }, expected: { type: 'integer' }, seen_in: { type: 'integer' } } } },
  },
};

export async function sparkVerdict(frames: { frame: number; file: string }[], expected: { phrase: string; expected: number }[], fps: number): Promise<SparkResult> {
  const model = 'muse-spark-1.3';
  assertModel(model, { customerData: false });
  const prompt = [
    'You are checking one parcel being packed at a warehouse bench, filmed from above.',
    `The frames below are in time order (source ${fps} frames per second); each is stamped with its frame number and seconds.`,
    'There is roughly one frame per second, with extra consecutive frames around the moments where the detector saw an item appear or vanish. Look closely at those runs: that is usually where an item goes into packaging.',
    'Coloured boxes are object detections from a segmentation model, labelled with what they were prompted for. They can miss objects or mark wrong ones; trust what you see in the image over the boxes.',
    `The barcode scan says the parcel must contain: ${expected.map((e) => `${e.expected} x ${e.phrase}`).join(', ')}.`,
    'Packaging can be nested (for example an item goes into a cloth pouch, the pouch into a box). An item counts as packed if it ends up inside the final closed container, directly or inside inner packaging.',
    'Ignore spare stock lying elsewhere on the desk.',
    'Work out what went into the parcel and whether anything was taken back out before it was closed.',
    'Verdict: "consistent" if what you saw matches the scan, "mismatch" if it clearly does not, "uncertain" if the frames do not show enough to tell. Never guess; prefer uncertain.',
    'In steps, cite the frame number for each thing you saw happen.',
  ].join('\n');
  const content = [
    { type: 'input_text', text: prompt },
    ...frames.map((f) => ({ type: 'input_image', image_url: `data:image/jpeg;base64,${fs.readFileSync(f.file).toString('base64')}` })),
  ];
  // ~1,000 image tokens per 640 px frame plus the prompt; generous output for reasoning.
  const estimate = (frames.length * 1000 + 1500) * PRICE.sparkIn + 6000 * PRICE.sparkOut;
  const res = await spend(estimate, 'spark:verdict', () => meta.responses.create({
    model,
    input: [{ type: 'message', role: 'user', content }] as never,
    text: { format: { type: 'json_schema', name: 'pack_check', schema: SCHEMA, strict: true } },
  } as never));
  const text = (res as { output_text?: string }).output_text ?? '';
  return JSON.parse(text) as SparkResult;
}
