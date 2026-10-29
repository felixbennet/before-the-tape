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

## Day 3, Thu Oct 29 2026

- First real bench footage: an iPhone looking down at the packing desk.
  Before anything goes to a model, each clip is trimmed to end before the
  shipping label appears and cropped to drop paperwork and the screen.
- What it showed: packers move the box around the desk, and packing is
  nested (wallet into a cloth pouch, pouch into the box). A fixed parcel
  region and "did it end inside the box" logic cannot follow that.
- Changes: the parcel is now tracked per frame with weak or tiny false
  boxes dropped, and Muse Spark 1.3 now reads one frame per second with
  SAM's boxes drawn on them and returns a structured verdict with the
  frame it saw each step on.
- First run (20 s clip, wallet plus care card): Spark followed the whole
  sequence, noted where SAM had mislabelled the box lid, saw the pouch go
  into the box at 15 s and the care card at 17 s, saw nothing taken out,
  and answered UNCERTAIN because the wallet going into the pouch fell
  between its sampled frames. That is the behaviour we want: it would
  rather say "I did not see it" than guess.
- Then let SAM tell Spark where to look: besides one frame per second,
  Spark now gets every frame around the moments SAM saw an item appear or
  vanish (45 frames for the 20 s clip). Same clip, rerun: CONSISTENT. Spark
  cited the wallet going into the pouch at 10.0 s, the pouch into the box
  at 15.0 s, the care card at 17.0 s, the lid at 18.0 s, and noted the
  spare wallets on the desk were never touched.
- Telling detail: SAM's tracks alone said MISMATCH for the wallet (it
  vanished into the pouch, so it never looked "inside the box"). Neither
  model gets this right alone; together they do.
- Two more real packs from the live bench, plus a wrong-scan test. Packing
  is live production, so nobody is asked to make mistakes on purpose;
  instead the mismatch test gives the checker a scan list that is wrong.

  | Clip | Scan list given | SAM tracks alone | SAM + Muse Spark | Correct answer |
  |---|---|---|---|---|
  | bench-02 | 1 wallet, 1 care card | wallet uncertain | CONSISTENT | consistent |
  | bench-05 | 1 wallet | uncertain | CONSISTENT | consistent |
  | bench-06 | 1 wallet, 1 care card | care card mismatch | CONSISTENT | consistent |
  | bench-02 | 2 wallets, 1 care card (wrong on purpose) | mismatch | MISMATCH | mismatch |

  4 of 4 right with Spark; SAM's tracks alone were right on 1 of 4. Spark
  cited each step by frame (scan, into pouch, pouch into box, care card,
  lid, box into mailer) and in the wrong-scan run said the second wallet
  "never picked and remains as spare stock".
- SAM mislabels came from naming things by what they are, not how they
  look: "leather care card" landed on the brown box lid. Prompted as
  "white printed card" instead, SAM found only the real card, and only on
  the frames it lies in the box (77 to 82), with nothing on the lid.
  Item phrases will describe appearance from now on.
- Also fixed a bug where the frame counter read "100," as not-a-number,
  which slipped past the spend cap. The cap now refuses any unreadable
  cost. Spend to date: $0.72.
