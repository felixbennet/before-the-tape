# BeforeTheTape

A phone over a packing bench that watches what actually goes into each parcel,
reconciles it against the barcode scan, and keeps the evidence for when a
claim or courier dispute arrives. Built for the Meta Global AI Developer
Hackathon (Oct 26 to Nov 4, 2026), Startup track.

Status: day 3. Runs end to end on real bench footage: SAM 3.1 tracks the
parcel and items, Muse Spark 1.3 follows the nested packing and picks which
catalogue photo the packed item is. First results are in [DEVLOG.md](DEVLOG.md).

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
pnpm test                         # decision logic, no API calls
```

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
   including the model contradicting itself, is **uncertain**. It never guesses.
