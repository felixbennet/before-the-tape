# BeforeTheTape

A phone over a packing bench that watches what actually goes into each parcel,
reconciles it against the barcode scan, and keeps the evidence for when a
claim or courier dispute arrives. Built for the Meta Global AI Developer
Hackathon (Oct 26 to Nov 4, 2026), Startup track.

Status: submitted prototype. It checks recorded bench clips end to end: SAM
3.1 tracks the parcel and items, Muse Spark 1.3 follows the nested packing
and picks which catalogue photo the packed item is, and code decides the
verdict. Early results, with the exact test cases, are in [DEVLOG.md](DEVLOG.md).
A live pause at the bench before the seal is the next step, not built yet.

## What existed before the hackathon, and what was built during it

| Existed before Oct 26, 2026 (not part of this entry) | Built during the hackathon (this repo) |
|---|---|
| Our warehouse, packing benches and barcode scan log | Everything in this repository |
| Product catalogue images | |

Every commit in this repository was made during the build window.
Built by Felix Bennet. Code written with AI coding agents under my direction;
architecture, testing and decisions are mine. Daily notes: [DEVLOG.md](DEVLOG.md).

## Meta models used

- **SAM 3.1** segments and tracks the parcel and each item through bench video.
- **Muse Spark 1.3** reads the frames SAM points it to, follows the packing
  step by step, and tells the scanned product apart from look-alike variants.

## Setup

```bash
pnpm install
echo "MODEL_API_KEY=..." > .env   # Meta Model API key, never committed
pnpm smoke                        # free: checks the key and model access
pnpm sam <image|clip|url> "belt buckle"
pnpm check <clip> --item "wallet=1" --item "white printed card=1" \
  --ref "wallet=<catalogue photo>|<product>" --decoy "wallet=<look-alike photo>"
pnpm check <clip> ... --agent     # Muse Spark asks for the frames, close-ups or SAM follows it needs
pnpm receipt <clip> <check.json> --container "cream drawstring pouch"   # custody receipt + proof JPEG
pnpm exec tsx scripts/render-masks.ts <clip> out.mp4 "cardboard box" "wallet"   # SAM masks on the clip
pnpm test                         # decision logic, no API calls
```

## Agent mode: it asks instead of guessing

With `--agent`, Muse Spark starts from one frame per second plus SAM's track
events as text ("wallet disappears after frame 45"). If a step it must verify
happened between the frames it has, it answers uncertain and asks for
evidence: every frame in a range, or a full-resolution close-up of the item.
The code fetches exactly that (clamped, at most 15 frames a request, up to 3
rounds) and asks again. On bench-02, round 1 could not see the wallet go into
the pouch and asked for frames 46 to 60; round 2 saw it at frame 53 and the
check passed. A request for more evidence is never a pass.

Muse Spark can also point SAM at one object: every box on a frame is named
by tag and position ("B2"), and a `follow` request makes SAM 3.1 re-track
that single object from a box prompt, so spare stock of the same kind
drops out.

## Custody receipt

Marketplace and courier claims in India are often rejected on procedure: a
cut in the video, or nothing proving the item stayed in the box.
`pnpm receipt` checks the take is unbroken (frame timestamps, scene cuts),
has SAM 3.1 follow the exact item the packer handled with a box prompt until
it vanishes into its container, follows that container until it is inside
the parcel box, and writes one proof JPEG (well under the 2 MB claim limit)
with the scan, the verdict, the key frames and the clip's SHA-256. On
bench-02: one unbroken 20 s take, 0 cuts; wallet followed from frame 11 to
frame 54 into the pouch; pouch in view with 0 frames missing until inside
the box at frame 87.

## How the check decides

1. **SAM 3.1** finds the parcel on every frame (packers move it) and tracks
   each scanned item. Items are named by how they look ("white printed
   card"), not what they are, which stops SAM boxing the wrong thing.
2. **Where to look.** The moments an item track starts or ends are where it
   goes into packaging. Muse Spark gets one frame per second plus dense runs
   around those moments, with SAM's boxes drawn on under neutral tags.
3. **What the item is.** The track that moved (spare stock lies still) gives
   full-resolution close-ups of the item as it was handled. Muse Spark sees
   them next to the catalogue photo of the scanned variant and look-alike
   variants, shuffled and unlabelled, and picks one, or says it cannot tell.
4. **What happened.** Muse Spark follows the nesting (item into pouch, pouch
   into box, box into mailer), cites a frame for each step and counts what
   ended up inside.
5. **The verdict is decided in code**, not by the model. **Consistent** needs
   every link: cited frames that it was really shown, counts equal to the
   scan, and the scanned photo picked. A different photo picked, or a
   counted shortfall it also calls a mismatch, is **mismatch**. Anything else,
   including the model contradicting itself, is **uncertain**, never a pass.
