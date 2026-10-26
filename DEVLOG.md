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
