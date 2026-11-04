// "Say it" voice scan. Many small sellers have no barcode scanner, so the packer
// says the order out loud, often in Hinglish. Muse Voice Transcribe turns the
// voice note into text; Muse Spark maps the text onto the bench's scan
// vocabulary. The result is the --item list that `pnpm check` takes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { meta, spend, assertModel, PRICE } from './meta.js';

// Published price: $0.18 per hour of audio, billed in whole seconds.
const ASR_USD_PER_SECOND = 0.18 / 3600;

// phrase: a SAM phrase the bench tracks. says: what a packer calls it out loud.
// variants: catalogue names a scanned item can carry.
export type Vocabulary = { phrases: { phrase: string; says: string[] }[]; variants: string[] };
export const DEMO_VOCABULARY: Vocabulary = {
  phrases: [
    { phrase: 'wallet', says: ['wallet'] },
    { phrase: 'white printed card', says: ['leather care card', 'care card', 'printed card'] },
  ],
  variants: ['Cherry Blend', 'Rugged Brown', 'Luxury Cherry', 'Rich Brown'],
};

// One voice note, one turn (PUSH_TO_TALK) on POST /v1/asr/transcribe. The
// endpoint takes mono 16-bit PCM WAV at 16 or 24 kHz, so every input (phone
// voice notes are usually .ogg or .m4a) is converted to 24 kHz first.
export async function transcribe(audioFile: string, keywords: string[] = []): Promise<string> {
  const model = 'muse-voice-transcribe-1.0';
  // A voice recording is personal data: keep it on a Standard model.
  assertModel(model, { customerData: true });
  fs.mkdirSync('data/tmp', { recursive: true });
  const wav = path.join('data/tmp', `${path.parse(audioFile).name}-24k.wav`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', audioFile, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', wav]);
  const audio = fs.readFileSync(wav);
  const seconds = Math.ceil(audio.length / 48000); // 24 kHz x 2 bytes, mono
  const form = new FormData();
  form.append('request', new Blob([JSON.stringify({
    model, mode: 'PUSH_TO_TALK', audioEncoding: 'WAV', languageBias: ['Hindi', 'English'], ...(keywords.length ? { keywords } : {}),
  })], { type: 'application/json' }));
  form.append('audio', new Blob([audio], { type: 'audio/wav' }), path.basename(wav));
  const res = await spend(seconds * ASR_USD_PER_SECOND, 'asr:transcribe', async () => {
    const r = await fetch(`${meta.baseURL}/asr/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${meta.apiKey}` }, body: form });
    if (!r.ok) throw new Error(`Muse Voice Transcribe ${r.status}: ${await r.text()}`);
    return (await r.json()) as { transcript?: string };
  });
  if (!res.transcript?.trim()) throw new Error('Muse Voice Transcribe returned no transcript');
  return res.transcript.trim();
}

export type SpokenItem = { phrase: string; count: number; variant: string; heard: string };
export type SpeechScan = { items: SpokenItem[]; unclear: string[] };

const words = (s: string) => s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

// Maps a spoken order onto the vocabulary. Anything that does not map cleanly
// goes to unclear; the packer re-says or scans it, nothing is guessed.
export async function scanFromSpeech(text: string, vocab: Vocabulary): Promise<SpeechScan> {
  const model = 'muse-spark-1.3';
  assertModel(model, { customerData: false });
  const prompt = [
    'A packer at a packing bench said out loud what goes into one parcel, often in Hinglish (Hindi and English mixed).',
    'Hindi numbers: ek (एक) = 1, do (दो) = 2, teen (तीन) = 3, char (चार) = 4, paanch (पांच) = 5. "aur" (और) means "and".',
    `Transcript of what they said (Hindi words may be in Devanagari): "${text}"`,
    'Map it onto these scan phrases and nothing else:',
    ...vocab.phrases.map((p) => `- "${p.phrase}": the packer may call it ${p.says.map((s) => `"${s}"`).join(' or ')}`),
    `variant: the catalogue name the packer gave that item, one of ${vocab.variants.map((v) => `"${v}"`).join(', ')}; "" if they named none.`,
    'count: how many of that item. When one count is split across variants (for example two wallets, one of each colour), give one item per variant, so the counts add up to what was said.',
    'heard: the words from the transcript that item is based on, copied exactly.',
    'unclear: every part of the speech that names something to pack but does not map cleanly onto a phrase, a count and a variant above, quoted exactly. Never guess: an unknown product, a missing count, a count that does not add up, or a variant not in the list goes to unclear, not into items.',
  ].join('\n');
  const schema = {
    type: 'object', additionalProperties: false, required: ['items', 'unclear'], properties: {
      items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['phrase', 'count', 'variant', 'heard'], properties: {
        phrase: { type: 'string', enum: vocab.phrases.map((p) => p.phrase) },
        count: { type: 'integer' },
        variant: { type: 'string', enum: [...vocab.variants, ''] },
        heard: { type: 'string' },
      } } },
      unclear: { type: 'array', items: { type: 'string' } },
    },
  };
  const estimate = 1500 * PRICE.sparkIn + 1500 * PRICE.sparkOut;
  const res = await spend(estimate, 'spark:voice_scan', () => meta.responses.create({
    model,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }] as never,
    text: { format: { type: 'json_schema', name: 'voice_scan', schema, strict: true } },
    reasoning: { effort: 'low' },
  } as never));
  const out = (res as { output_text?: string }).output_text ?? '';
  if (!out.trim()) throw new Error('Muse Spark returned no answer');
  const scan = JSON.parse(out) as SpeechScan;
  // An item must rest on words that were actually said, with a real count.
  const said = new Set(words(text));
  const items = scan.items.filter((i) => Number.isInteger(i.count) && i.count > 0 && words(i.heard).length > 0 && words(i.heard).every((w) => said.has(w)));
  const dropped = scan.items.filter((i) => !items.includes(i)).map((i) => `${i.heard} (not backed by the transcript)`);
  return { items, unclear: [...scan.unclear, ...dropped] };
}
