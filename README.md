# BeforeTheTape

A phone over a packing bench that watches what actually goes into each parcel,
reconciles it against the barcode scan, and keeps the evidence for when a
claim or courier dispute arrives. Built for the Meta Global AI Developer
Hackathon (Oct 26 to Nov 4, 2026), Startup track.

Status: day 2. SAM 3.1 video tracking works on our product footage; the
packing-event logic (in, out, uncertain) is built and tested on hand-made
tracks. Bench footage comes next.

## What existed before the hackathon, and what was built during it

| Existed before Oct 26, 2026 (not part of this entry) | Built during the hackathon (this repo) |
|---|---|
| Our warehouse, packing benches and barcode scan log | Everything in this repository |
| Product catalogue images | |

Every commit in this repository was made during the build window.
Built by Felix Bennet. Code written with AI coding agents under my direction;
architecture, testing and decisions are mine. Daily notes: [DEVLOG.md](DEVLOG.md).

## Meta models used

- **SAM 3.1** segments and tracks products through bench video.
- **Muse Spark 1.3** (planned) checks what SAM tracked against the order.

## Setup

```bash
pnpm install
echo "MODEL_API_KEY=..." > .env   # Meta Model API key, never committed
pnpm smoke                        # free: checks the key and model access
pnpm sam <image|clip|url> "belt buckle"
pnpm check <clip> --item "belt=1" --item "belt buckle=1"
pnpm test                         # packing-event logic, no API calls
```

## How the check decides

SAM 3.1 finds the parcel and tracks each item through the clip. An item
counts as **in** once it is seen inside the parcel, and **out** if it then
leaves and stays out. Hands and box walls hide items and SAM gives a re-found
item a new id, so tracks that end and restart close together are joined. When
an item is lost on the rim of the parcel the result is **uncertain**, never a
guess. The net count per item is compared with the scan: every item matches
means **consistent**, any difference means **mismatch**.
