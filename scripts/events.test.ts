// Checks for the packing-event logic, on hand-made tracks (no API calls).
//   pnpm test
import assert from 'node:assert/strict';
import type { Box, Hit } from '../src/sam.js';
import { packEvents, parcelRegion, parcelTrack, pickFrames, trackEdges, verdict } from '../src/events.js';

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

// The parcel region ignores a low-confidence false box and a tiny one.
const parcelHits: Hit[] = [0, 1, 2, 3, 4].map((f) => ({ frame: f, id: 0, box: [400, 400, 800, 800] as Box, c: 0.9 }));
parcelHits.push({ frame: 2, id: 1, box: [100, 100, 900, 900], c: 0.5 });
parcelHits.push({ frame: 3, id: 2, box: [10, 10, 40, 40], c: 0.95 });
assert.deepEqual(parcelRegion(parcelHits), [400, 400, 800, 800]);

// The parcel moves across the desk: an item dropped into it at its new place still counts.
const moving: Hit[] = [
  ...[0, 1, 2].map((f) => ({ frame: f, id: 0, box: [100, 100, 300, 300] as Box, c: 0.9 })),
  ...[3, 4, 5].map((f) => ({ frame: f, id: 0, box: [600, 100, 800, 300] as Box, c: 0.9 })),
];
const track = parcelTrack(moving)!;
const intoMovedBox = path(5, 0, [[400, 600], [500, 400], [600, 250], [700, 200], [700, 200]]);
assert.equal(verdict(packEvents(intoMovedBox, track, { totalFrames: 40 }), 1).verdict, 'consistent');

// Spark gets one frame per second plus a dense run around the moment an item vanished.
assert.deepEqual(trackEdges(dropIn, 40), [4]);
assert.deepEqual(pickFrames(12, 5, [7], 1), [0, 5, 6, 7, 8, 10]);

console.log('events: all checks passed');
