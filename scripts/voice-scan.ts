// "Say it" voice scan: a packer's spoken order becomes the scan list for pnpm check.
//
//   tsx scripts/voice-scan.ts <audio file>
//
// Prints the transcript, the structured list and the exact --item arguments,
// and saves them to data/voice/<name>.scan.json.
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_VOCABULARY, scanFromSpeech, transcribe } from '../src/voice.js';

const audio = process.argv[2];
if (!audio || !fs.existsSync(audio)) throw new Error('usage: tsx scripts/voice-scan.ts <audio file>');
const vocab = DEMO_VOCABULARY;

const transcript = await transcribe(audio, [...vocab.variants, ...vocab.phrases.flatMap((p) => p.says)]);
console.log(`transcript: ${transcript}\n`);

const scan = await scanFromSpeech(transcript, vocab);
console.log('scan list:');
for (const i of scan.items) console.log(`  ${i.count} x ${i.phrase}${i.variant ? ` (${i.variant})` : ''}   heard: "${i.heard}"`);
if (!scan.items.length) console.log('  (nothing mapped)');

// pnpm check tracks each phrase once, so variants of one phrase add up.
const counts = new Map<string, number>();
for (const i of scan.items) counts.set(i.phrase, (counts.get(i.phrase) ?? 0) + i.count);
const itemArgs = [...counts].map(([phrase, n]) => `--item "${phrase}=${n}"`);
console.log(`\npnpm check <clip> ${itemArgs.join(' ')}`);
if (scan.unclear.length) {
  console.log('\nNOT READY, say these again or scan them:');
  for (const u of scan.unclear) console.log(`  - ${u}`);
}

fs.mkdirSync('data/voice', { recursive: true });
const out = path.join('data/voice', `${path.parse(audio).name}.scan.json`);
fs.writeFileSync(out, JSON.stringify({ audio, transcript, ...scan, itemArgs, ready: scan.unclear.length === 0 }, null, 2));
console.log(`\nsaved ${out}`);
