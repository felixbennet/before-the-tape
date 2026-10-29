// Checks for the packing-event logic, on hand-made tracks (no API calls).
//   pnpm test
import assert from 'node:assert/strict';
import type { Box, Hit } from '../src/sam.js';
import { closeups, packEvents, parcelRegion, parcelTrack, pickFrames, trackEdges, verdict } from '../src/events.js';
import { parseHits } from '../src/sam.js';
import { decide, shuffleCandidates, type Expected, type SparkRaw } from '../src/spark.js';

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
assert.deepEqual(pickFrames(12, 5, [7], 1), [0, 5, 6, 7, 8, 10, 11]);
// A 90 s clip still gets its dense frames, and the last frame is always shown.
const long = pickFrames(450, 5, [400], 3);
assert.equal(long.length, 29);
for (const f of [397, 400, 403, 449]) assert.ok(long.includes(f));
// With many edges, every edge frame gets in before any neighbour does.
const many = pickFrames(100, 5, [12, 33, 57, 81], 3, 25);
for (const f of [12, 33, 57, 81]) assert.ok(many.includes(f));

// Close-ups come from the handled item, not the spare one lying still.
const still = path(9, 0, Array.from({ length: 20 }, () => [100, 100] as [number, number]));
const handled = path(2, 0, Array.from({ length: 20 }, (_, i) => [100 + i * 20, 600] as [number, number]));
handled[8].box = [200, 500, 400, 700];
const shots = closeups([...still, ...handled]);
assert.equal(shots[0].frame, 8);
assert.ok(shots.every((h) => h.id === 2 && h.frame < 17));
assert.ok(Math.abs(shots[0].frame - shots[1].frame) >= 5);

// SAM's stream can split a record across deltas; records are found by frame marker.
assert.equal(parseHits('<3f>0<|box;x1=1;y1=2;x2=3;y2=4;w=9;h=9;c=0.9|><4f>0<|box;x1=5;y1=6;x2=7;y2=8;w=9;h=9;c=0.8|>').length, 2);

// The verdict is decided in code from what Spark reports.
const wallet: Expected = { phrase: 'wallet', expected: 1, image: 'scanned.jpg', decoys: ['lookalike.jpg'] };
const cand = { photos: ['lookalike.jpg', 'scanned.jpg'], answer: 2 };
const raw = (over: Partial<SparkRaw> = {}, pick = 2, seen = 1): SparkRaw => ({
  verdict: 'consistent', summary: '', steps: [{ frame: 10, seconds: 99, what: 'into pouch' }],
  counts: [{ item: 'wallet', expected: 1, seen_in: seen, reference_pick: pick, reference_note: '' }], ...over,
});
const d = (r: SparkRaw) => decide(r, [wallet], [cand], [0, 5, 10], 5);
assert.equal(d(raw()).verdict, 'consistent');
assert.equal(d(raw()).steps[0].seconds, 2);
assert.equal(d(raw({}, 1)).verdict, 'mismatch');
assert.equal(d(raw({}, -1)).verdict, 'mismatch');
assert.equal(d(raw({}, 0)).verdict, 'uncertain');
assert.equal(d(raw({ steps: [{ frame: 11, seconds: 0, what: 'x' }] })).verdict, 'uncertain');
assert.equal(d(raw({}, 2, 0)).verdict, 'uncertain');
assert.equal(d(raw({ verdict: 'mismatch' }, 2, 0)).verdict, 'mismatch');
assert.equal(d(raw({ verdict: 'mismatch' })).verdict, 'uncertain');
assert.equal(decide(raw({}, 0), [{ phrase: 'wallet', expected: 1 }], [null], [10], 5).verdict, 'consistent');
assert.equal(shuffleCandidates(wallet, () => 0)!.answer, 2);

console.log('events: all checks passed');
