// Returns bench: is the item that came back the item we packed?
//
//   pnpm returns <outbound clip> --returned <image> [--returned <image> ...] [--item wallet]
//
// The outbound side is the close-ups SAM 3.1 cut from that order's packing
// video (data/crops/<clip>/, written by `pnpm check`). Muse Spark compares them
// with photos of the returned item; code turns the answer into a refund action.
import fs from 'node:fs';
import path from 'node:path';
import { compareReturn } from '../src/identify.js';

const args = process.argv.slice(2);
const clipPath = args[0];
const flag = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const returned = flag('returned');
const item = flag('item')[0] ?? 'wallet';
if (!clipPath || !returned.length) throw new Error('usage: pnpm returns <outbound clip> --returned <image> [...]');
const cropDir = path.join('data/crops', path.parse(clipPath).name);
const outbound = fs.existsSync(cropDir) ? fs.readdirSync(cropDir).filter((f) => f.endsWith('.jpg')).sort().slice(0, 3).map((f) => path.join(cropDir, f)) : [];
if (!outbound.length) throw new Error(`no outbound close-ups in ${cropDir}; run pnpm check on the packing clip first`);

const v = await compareReturn(outbound, returned, item);
const action = v.same_product === 'yes' ? 'ACCEPT RETURN' : v.same_product === 'no' ? 'HOLD REFUND: returned item is not the one we packed' : 'INSPECT BY HAND: images do not settle it';
console.log(`${action}\n  ${v.note}`);
for (const d of v.differences) console.log(`  - differs: ${d}`);
for (const m of v.matching) console.log(`  + matches: ${m}`);
fs.mkdirSync('data/returns', { recursive: true });
const out = `data/returns/${path.parse(clipPath).name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(out, JSON.stringify({ outboundClip: clipPath, outbound, returned, verdict: v, action }, null, 2));
console.log(out);
