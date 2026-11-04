// Fast identity questions for Muse Spark, small enough to answer while the
// packer is still working (live pause) or at the returns bench.
import fs from 'node:fs';
import { meta, spend, assertModel, PRICE } from './meta.js';

const imagePart = (src: string) => ({
  type: 'input_image',
  image_url: /^https?:\/\//.test(src) ? src : `data:image/jpeg;base64,${fs.readFileSync(src).toString('base64')}`,
});

async function ask<T>(content: unknown[], schema: object, name: string, images: number, effort?: 'low' | 'medium' | 'high'): Promise<T> {
  const model = 'muse-spark-1.3';
  assertModel(model, { customerData: false });
  const estimate = (images * 1000 + 1500) * PRICE.sparkIn + 3000 * PRICE.sparkOut;
  const res = await spend(estimate, `spark:${name}`, () => meta.responses.create({
    model,
    input: [{ type: 'message', role: 'user', content }] as never,
    text: { format: { type: 'json_schema', name, schema, strict: true } },
    ...(effort ? { reasoning: { effort } } : {}),
  } as never));
  const text = (res as { output_text?: string }).output_text ?? '';
  if (!text.trim()) throw new Error('Muse Spark returned no answer');
  return JSON.parse(text) as T;
}

// Which catalogue photo is the item in these bench frames? 0 = cannot tell, -1 = none.
export async function pickVariant(frames: string[], photos: string[], item: string, effort?: 'low' | 'medium' | 'high'): Promise<{ pick: number; note: string }> {
  const prompt = [
    `These frames are from a packing bench camera, filmed from above, a moment ago. The packer is holding the ${item} that was just scanned.`,
    `Below them are ${photos.length} numbered catalogue photos of similar products that differ in colour, leather finish, stitching or branding position.`,
    `pick: the number of the photo that is the same product as the ${item} in the packer's hands; 0 if the frames do not show enough to tell; -1 if it is none of them. Judge colour and finish under bench lighting carefully. In note, name the features you compared, in one sentence.`,
  ].join('\n');
  return ask(
    [{ type: 'input_text', text: prompt }, { type: 'input_text', text: 'BENCH FRAMES:' }, ...frames.map(imagePart),
      ...photos.flatMap((p, i) => [{ type: 'input_text', text: `Photo ${i + 1}:` }, imagePart(p)])],
    { type: 'object', additionalProperties: false, required: ['pick', 'note'], properties: { pick: { type: 'integer' }, note: { type: 'string' } } },
    'variant_pick', frames.length + photos.length, effort);
}

// Is the returned item the product we packed? Compares outbound close-ups with return-intake images.
export type ReturnVerdict = { same_product: 'yes' | 'no' | 'unclear'; differences: string[]; matching: string[]; note: string };
export async function compareReturn(outbound: string[], returned: string[], item: string): Promise<ReturnVerdict> {
  const prompt = [
    `A customer returned a ${item}. The first images are close-ups of the ${item} we packed for this order, cut from our packing video.`,
    `The second set shows the ${item} that came back, photographed at our returns bench.`,
    `same_product: "yes" if the returned ${item} is the same product (same model, colour, leather finish, stitching, branding position and interior layout), "no" if it clearly differs in any of these, "unclear" if the images do not show enough. Lighting and angles differ; judge the features you can actually see in both sets.`,
    'List the concrete differences and the concrete matching features you saw. In note, one sentence for a refund reviewer.',
  ].join('\n');
  return ask(
    [{ type: 'input_text', text: prompt }, { type: 'input_text', text: 'PACKED (outbound close-ups):' }, ...outbound.map(imagePart),
      { type: 'input_text', text: 'RETURNED (returns bench):' }, ...returned.map(imagePart)],
    { type: 'object', additionalProperties: false, required: ['same_product', 'differences', 'matching', 'note'], properties: {
      same_product: { type: 'string', enum: ['yes', 'no', 'unclear'] }, differences: { type: 'array', items: { type: 'string' } },
      matching: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } },
    'return_check', outbound.length + returned.length);
}
