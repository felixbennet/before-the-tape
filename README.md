# BeforeTheTape

A phone over a packing bench that watches what actually goes into each parcel,
reconciles it against the barcode scan, and keeps the evidence for when a
claim or courier dispute arrives. Built for the Meta Global AI Developer
Hackathon (Oct 26 to Nov 4, 2026), Startup track.

Status: submitted prototype. It checks recorded bench clips end to end: SAM
3.1 tracks the parcel and items, Muse Spark 1.3 follows the nested packing
and picks which catalogue photo the packed item is, and code decides the
verdict. It also runs live (a pause before the seal), writes a custody
receipt for claims, and checks returns. Early results, with the exact test
cases, are in [DEVLOG.md](DEVLOG.md).

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
- **Muse Voice Transcribe 1.0** turns a packer's Hinglish voice note into the
  scan list.

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
pnpm live <clip> --scan-at 4.0 --seal-at 21.8 --ref "<photo>|<product>" --decoy <photo>   # live pause
pnpm returns <outbound clip> --returned <photo> --returned <photo>   # returns bench
pnpm verify <clip> --receipt data/receipts/<clip>.json   # is this the untouched recorded take?
pnpm appeal data/receipts/<clip>.json --claim "<claim text>"   # point-by-point claim reply
pnpm exec tsx scripts/voice-scan.ts <voice note>   # Hinglish voice note -> scan list (Muse Voice Transcribe)
pnpm exec tsx scripts/trust-clip.ts <clip> <receipt.json> --follow-run <run> --out <mp4>   # "packed for you" clip
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

## Live pause

`pnpm live` runs while the packer is still working. The barcode scan
triggers it: the last second of camera frames and the shuffled catalogue
line-up go to Muse Spark (low reasoning effort, so it answers in seconds),
and the bench gets CONTINUE or PAUSE before the parcel is sealed. Tested on
real-time replays of the bench clips (the recorded clip plays at real speed
as the camera feed; the scan time comes from the scan log): 4 of 4 right,
both wrong scans paused and both right scans continued, 7 to 9 s after the
scan. On bench-05 the PAUSE landed at 12.6 s, before the pouch reached the
box (16 s), the lid (17.8 s) and the mailer seal (21.8 s).

## Returns bench

`pnpm returns` compares the item that came back with the close-ups SAM cut
from that order's packing video, and turns Muse Spark's answer into an
action: ACCEPT RETURN, HOLD REFUND, or INSPECT BY HAND. Controlled tests
(return photos stand in from our bench clips): a burgundy wallet returned for
a brown order gave HOLD REFUND ("the packed wallet was brown while the
returned wallet is clearly maroon/burgundy"); the brown wallet itself, shown
only closed, gave INSPECT BY HAND and asked for a photo of the open interior
before refunding.

## Try to fool it

`pnpm verify` checks a copy of the evidence against the receipt: the
SHA-256 written at packing time, and frame-to-frame jumps (ffmpeg scdet; our
real takes peak near 1.2). For each jump, Muse Spark says what changed. We
forged our own evidence from bench-02: the original came back VALID; a
re-encoded copy NOT THE RECORDED FILE (hash mismatch, no jumps); 2 seconds
cut out TAMPERED at 9.5 s (jump 8.0: "the single hand holding a reddish-brown
wallet was replaced by two hands holding a cream-colored pouch"); another
pack spliced in TAMPERED at 9.5 s and 11.5 s (jump 26.0).

## Claims desk

`pnpm appeal` splits a claim into its assertions and marks each
contradicted, supported or unresolved from the receipt, with the frame that
shows it, then drafts a short reply citing frames and the hash. For "only the
empty pouch, no wallet, care card missing": the empty pouch and the missing
card are contradicted (frames 54 and 82); what happened in transit is
unresolved, because a packing video cannot show it. Any supported point goes
to a person.

## Voice scan

No barcode scanner? The packer says the order, in Hinglish. Muse Voice
Transcribe (`muse-voice-transcribe-1.0`, catalogue names as keywords) turns
the note into text, and Muse Spark maps it to the scan list `pnpm check`
takes. "Ek Cherry Blend wallet aur ek leather care card" became
`--item "wallet=1" --item "white printed card=1"` (Cherry Blend). Anything it
cannot map is listed as unclear, never guessed.

## Packed for you

Before a cash-on-delivery parcel arrives, the customer can get a short
vertical clip of their own wallet being packed: cut from the bench video,
the exact wallet spotlighted with SAM 3.1's mask, a one-line note from Muse
Spark, and the receipt hash.

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
