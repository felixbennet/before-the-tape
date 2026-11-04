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

### Day 3, later: is it the right product?

- A scan proves which product was meant; "a wallet went in" does not prove
  it was that one. Same model, different colour is the mistake that
  actually happens. So Muse Spark now gets the catalogue photo of the
  scanned variant mixed in with photos of look-alike variants, shuffled and
  unlabelled, and has to say which one was packed (or that it cannot tell).
  Picking from a line-up resists the "yes, looks like it" bias of a
  yes/no question.
- Asked for an outside review (GPT-6 Astra and Claude Opus). Both said the
  same three things, all now done: let the code, not the model, decide the
  verdict from what the model reports (cited frames must be ones it was
  shown, counts must match, the right photo must be picked); stop the 1 fps
  frames eating the whole frame budget on long clips; give the identity
  check a close-up instead of a small 640 px frame. Also from the review:
  boxes are drawn with neutral tags (A, B) so a mislabelled box does not
  tell Spark what it is looking at, and SAM runs once per clip and phrase
  and is reused across test variants.
- Test set: two real packs of the same wallet model in two different
  variants (one burgundy smooth, one brown distressed). Each was checked
  against its true catalogue photo and against a wrong one. "Hard" line-ups
  hold four photos, three of them near-identical burgundy variants (Spark,
  shown each photo alone, described all three almost word for word the
  same). "Distinct" line-ups hold three clearly different colours.

  | Run | Scanned photo | Line-up | Without close-ups | With close-ups | Correct |
  |---|---|---|---|---|---|
  | burgundy pack | true | hard | MISMATCH (picked a sibling) | UNCERTAIN | consistent |
  | burgundy pack | wrong (brown) | hard | UNCERTAIN | MISMATCH, picked the true photo | mismatch |
  | brown pack | true | hard | UNCERTAIN | CONSISTENT | consistent |
  | brown pack | wrong (burgundy) | hard | UNCERTAIN | MISMATCH, picked the true photo | mismatch |
  | burgundy pack | true | distinct | | CONSISTENT | consistent |
  | brown pack | wrong (green) | distinct | | MISMATCH, picked the true photo | mismatch |

  With close-ups: 5 right, 1 uncertain, 0 wrong. Every time it named a
  photo it named the true product. Without close-ups it mostly could not
  tell and once picked a near-identical sibling, a confident wrong answer;
  that is the failure the close-ups fixed here.
- Packing itself, rerun with the new frame picker and tags: maroon-wallet
  pack with no photo CONSISTENT, same pack with a wrong scan of two
  wallets MISMATCH ("only 1 wallet ever entered packaging").
- Honest size of this: two independent packing scenes, multiplied into
  variants. It shows the method works, not an accuracy rate. Next: more
  clips, ground truth written down before running, prompts frozen, and
  the confusion table reported with the uncertain rate.
- Spend to date: $1.90.

## Day 9, Wed Nov 4 2026: results on the final pipeline, and the demo

- The day 3 packing table above was run before the verdict moved into
  code and before the new frame picker. Re-read on the final pipeline
  (saved checks from the later runs, same four cases):

  | Clip | Scan list given | SAM tracks alone | SAM + Muse Spark | Correct answer |
  |---|---|---|---|---|
  | bench-02 | 1 wallet, 1 care card | mismatch | CONSISTENT | consistent |
  | bench-02 | 2 wallets, 1 care card (wrong on purpose) | mismatch | MISMATCH | mismatch |
  | bench-05 | 1 wallet | uncertain | CONSISTENT | consistent |
  | bench-06 | 1 wallet, 1 care card | consistent | CONSISTENT | consistent |

  SAM's tracks alone: 2 of 4 (1 of 4 on the day 3 pipeline). SAM with
  Muse Spark: 4 of 4. Muse Spark's packing verdict was also consistent in
  all 12 variant-test runs on bench-05 and bench-06. Three real packs plus
  one deliberately wrong scan; small, and reported as such.
- The bench-06 step times in the demo (wallet into pouch at frame 40,
  8.0 s; pouch into box at frame 70; card at 78; lid at 83; mailer at 95)
  come from the saved bench-06 run of 29 Oct 13:21 UTC. The 10.0 / 15.0 /
  17.0 s times earlier in this log are from bench-02, a different clip.
- Cost per check at list prices: SAM 3.1 video is $0.20 per 1000 frames,
  so a 20 s clip at 5 fps (100 frames) is about $0.02 per phrase, three
  phrases about $0.06; one Muse Spark verdict with about 45 frames, close
  ups and four catalogue photos averaged about $0.09 across the six
  variant runs. Under $0.20 a check.
- Built the 3-minute demo video (HyperFrames, HTML rendered to video)
  from the real bench clips with SAM's boxes burned in and Muse Spark's
  cited steps. An outside review (GPT-6 Astra and Claude Opus) tightened
  the claims: denominators on every number, "uncertain, never a pass"
  instead of "never guesses", and the wrong-scan test labelled as a
  controlled test.
- Spend to date: $1.99.

### Day 9, later: an agent loop and real masks

- Outside reviews (GPT-6 Astra, Gemini 4 Argon, Claude Opus) all said the
  same thing: it looked like a fixed pipeline that draws boxes. Two changes.
- Agent mode (`--agent`): Muse Spark starts from one frame per second plus
  SAM's track events as text, and asks for the frames or close-ups it needs.
  Results, all three runs that began uncertain:

  | Clip | Scan | Round 1 | Asked for | Final | Correct |
  |---|---|---|---|---|---|
  | bench-02 | 1 wallet, 1 card | UNCERTAIN (21 frames) | frames 46-60, "need to see wallet being inserted into pouch" | CONSISTENT (33 frames), wallet into pouch at frame 53 | consistent |
  | bench-05 | Rugged Brown (true) | UNCERTAIN (22 frames) | four frame ranges around each transfer | CONSISTENT, picked the scanned photo | consistent |
  | bench-05 | Cherry Blend (wrong on purpose) | UNCERTAIN (22 frames) | three frame ranges and a close-up | MISMATCH, picked the brown wallet really packed | mismatch |

- SAM masks: the one-bit masks SAM 3.1 already returned are now decoded
  with Meta's `@meta-sam/parser` and painted onto the clips
  (`scripts/render-masks.ts`), from the saved runs, no new calls.
- Spend to date: $2.50.
- Agent `follow` action: boxes are named per frame ("B2"); Muse Spark can ask
  SAM 3.1 to re-track one object from a box prompt. Tested on bench-02 from
  the wallet in hand at frame 15: one identity from the stack (frame 0)
  through the hands to the pouch mouth, last seen frame 53, the same frame
  Muse Spark found; spare wallets dropped out. In the next full agent run
  Muse Spark chose frame ranges (46-60, then 81-84) rather than a follow and
  ended CONSISTENT in round 3.
- Custody receipt (`pnpm receipt`), after reading how Indian marketplace
  claims get rejected (cuts in video, nothing tying the item to the box).
  bench-02: one unbroken take (1199 frames, max timestamp gap 33 ms, 0 scene
  cuts); SAM followed the handled wallet frame 11 to 54; "cream drawstring
  pouch" tracked with 0 missing frames until inside the box at frame 87
  ("cloth pouch" found nothing; appearance words again). Proof JPEG 169 KB.
- Spend to date: $2.78.

### Day 9, late night: live pause and returns bench

- Live pause (`pnpm live`): the scan triggers a small Muse Spark call (2
  frames from the second before the scan, the shuffled line-up, low
  reasoning effort). First try at default effort with 3 frames took 15 s and
  landed after the lid; low effort with 2 frames: 7 to 9 s.

  | Clip | Scan | Muse Spark picked | Bench | Latency |
  |---|---|---|---|---|
  | bench-05 | Cherry Blend (wrong) | Rugged Brown | PAUSE | 8.6 s |
  | bench-05 | Rugged Brown (right) | Rugged Brown | CONTINUE | 8.7 s |
  | bench-06 | Rugged Brown (wrong) | Cherry Blend | PAUSE | 7.3 s |
  | bench-06 | Cherry Blend (right) | Cherry Blend | CONTINUE | 7.2 s |

  Real-time replays of recorded clips stand in for the camera feed.
- Returns bench (`pnpm returns`): Muse Spark compares the return photos with
  the outbound close-ups SAM cut from the packing video. Burgundy wallet for
  a brown order: HOLD REFUND. The brown wallet itself, closed only: INSPECT
  BY HAND, asking for an interior photo. Return photos stand in from bench
  clips; real returns footage is next.
- Spend to date: $2.93.
