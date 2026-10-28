# Build log

## Day 0, Mon Oct 26 2026 (IST night)

- Kickoff watched. Rules that shape the build: new work only, public repo,
  demo only what was built here, no data we lack rights to.
- Decided the project after several rounds of review: a packing-bench witness.
  A barcode scan proves an item was scanned, not that it went into the box.
- Set up the repo, the Meta Model API client, a hard spend cap ($120 of the
  $150 credits) and a guard against Contributor models on customer data.
- First SAM 3.1 calls on one of our catalogue photos (Oxford belt, black):
  "belt buckle" found 1 object at confidence 0.80, "leather belt" 1 object at
  0.93. Cost so far: $0.005.
- Learned from the docs: video is billed per frame with a 50-frame minimum per
  request, one noun phrase per request, and object ids are not guaranteed to
  survive full occlusion. Counting items into a box has to handle that.

Next: film 20 to 30 real packs on the bench, including deliberate mistakes,
and run them through `pnpm sam` to decide go or no-go.

## Day 2, Wed Oct 28 2026

- First video test, before any bench footage: one of our own 24-second
  product videos (a tan belt handled on a table and worn), downsampled to
  5 fps, 120 frames. Prompt "belt buckle". Cost $0.024.
- SAM 3.1 found buckles on 73 of 120 frames at 0.83 to 0.92 average
  confidence. Checked by drawing the boxes back onto frames: every box was a
  real buckle, including one half hidden in a hand and two loose buckles on
  the table. Frames with no buckle in view (strap end, coiled belt, belt worn
  with the buckle out of shot) correctly returned nothing.
- When the belt in hand left the scene, the count dropped from 4 to 3. That
  drop is the signal the bench check needs ("an item went out").
- Object ids changed at scene cuts (7 ids for what is mostly 4 buckles).
  So counting cannot trust ids alone; it has to count events (enter, leave)
  and reconcile against the scan.
- Built that event logic (`src/events.ts`): parcel region from the median of
  SAM's parcel boxes, item tracks joined across short gaps, and three
  outcomes. Tested on hand-made tracks (`pnpm test`): drop-in, in then taken
  back out, re-found under a new id, spare belt left on the table, lost on
  the rim, and one of two scanned items missing.
- `pnpm check <clip>` runs the whole thing on a clip. It needs real bench
  footage with a parcel in frame to be meaningful.
