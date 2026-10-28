// Checks for the packing-event logic, on hand-made tracks (no API calls).
//   pnpm test
import assert from 'node:assert/strict';
import type { Box, Hit } from '../src/sam.js';
import { packEvents, parcelRegion, verdict } from '../src/events.js';

const parcel: Box = [400, 400, 800, 800];
// A 60 px item whose center follows the given points, one point per frame.
const path = (id: number, start: number, points: [number, number][]): Hit[] =>
  points.map(([x, y], i) => ({ frame: start + i, id, box: [x - 30, y - 30, x + 30, y + 30], c: 0.9 }));
const run = (hits: Hit[], expected: number, totalFrames = 40) => verdict(packEvents(hits, parcel, { totalFrames }), expected);

// Carried from the table into the parcel, then hidden by the box walls.
const dropIn = path(1, 0, [[100, 600], [250, 600], [400, 600], [550, 600], [600, 600]]);
assert.deepEqual(run(dropIn, 1), { verdict: 'consistent', net: 1 });

// The scanner says 1, but the item went in and was taken back out to the table.
const inAndOut = path(1, 0, [[100, 600], [600, 600], [600, 600], [300, 600], [150, 600], [100, 600], [100, 600]]);
assert.deepEqual(run(inAndOut, 1), { verdict: 'mismatch', net: 0 });

// One item, two SAM ids: hidden by a hand for 2 frames inside the parcel, then re-found.
const reFound = [...path(1, 0, [[100, 600], [600, 600], [610, 600]]), ...path(7, 5, [[615, 605], [620, 600]])];
assert.deepEqual(run(reFound, 1), { verdict: 'consistent', net: 1 });

// A spare belt that stays on the table is not part of the parcel.
const spare = path(3, 0, [[100, 100], [110, 100], [105, 100]]);
assert.deepEqual(run([...dropIn, ...spare], 1), { verdict: 'consistent', net: 1 });

// Lost exactly on the rim: the camera cannot say whether it dropped in.
const onRim = path(1, 0, [[100, 600], [300, 600], [395, 600]]);
assert.equal(run(onRim, 1).verdict, 'uncertain');

// Two items scanned, only one went in.
assert.deepEqual(run([...dropIn, ...spare], 2), { verdict: 'mismatch', net: 1 });

// The parcel region ignores one frame where a hand made its box much larger.
const parcelHits: Hit[] = [0, 1, 2, 3, 4].map((f) => ({ frame: f, id: 0, box: [400, 400, 800, 800] as Box, c: 0.9 }));
parcelHits.push({ frame: 2, id: 1, box: [100, 100, 900, 900], c: 0.5 });
assert.deepEqual(parcelRegion(parcelHits), [400, 400, 800, 800]);

console.log('events: all checks passed');
