# Pack Witness

A phone over a packing bench that watches what actually goes into each parcel,
reconciles it against the barcode scan, and keeps the evidence for when a
claim or courier dispute arrives. Built for the Meta Global AI Developer
Hackathon (Oct 26 to Nov 4, 2026), Startup track.

Status: day 0. Scaffold and model smoke tests only.

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
```
