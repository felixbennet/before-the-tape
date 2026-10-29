// Turns SAM 3.1 boxes into packing events: an item went into the parcel, came
// back out, or did something the camera could not see clearly. Then checks the
// net count against what the barcode scan says should be in the parcel.
import type { Box, Hit } from './sam.js';

export type PackEvent = { kind: 'in' | 'out' | 'uncertain'; frame: number; why: string };
export type Verdict = 'consistent' | 'mismatch' | 'uncertain';
type Zone = 'inside' | 'edge' | 'outside';

const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);
const center = (b: Box) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const size = (b: Box) => Math.max(b[2] - b[0], b[3] - b[1]);
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Keep only detections that look like the real parcel: confident, and at least a
// quarter of the size of the biggest parcel box seen (drops small false boxes).
function parcelHits(hits: Hit[], minConf = 0.6): Hit[] {
  const sure = hits.filter((h) => Number.isNaN(h.c) || h.c >= minConf);
  const biggest = Math.max(0, ...sure.map((h) => area(h.box)));
  return sure.filter((h) => area(h.box) >= biggest / 4);
}

// A summary region for reports: the median of each edge of the parcel boxes.
export function parcelRegion(hits: Hit[]): Box | null {
  const boxes = parcelHits(hits).map((h) => h.box);
  if (!boxes.length) return null;
  return [0, 1, 2, 3].map((i) => median(boxes.map((b) => b[i]))) as Box;
}

// Packers move the box around, so the parcel is looked up per frame: its
// largest kept box on that frame, else the nearest frame that has one.
export function parcelTrack(hits: Hit[]): ((frame: number) => Box | null) | null {
  const byFrame = new Map<number, Box>();
  for (const h of parcelHits(hits)) {
    const cur = byFrame.get(h.frame);
    if (!cur || area(h.box) > area(cur)) byFrame.set(h.frame, h.box);
  }
  const frames = [...byFrame.keys()].sort((a, b) => a - b);
  if (!frames.length) return null;
  return (frame) => {
    const nearest = frames.reduce((best, f) => (Math.abs(f - frame) < Math.abs(best - frame) ? f : best), frames[0]);
    return byFrame.get(nearest) ?? null;
  };
}

// The edge band (a fraction of the parcel size on each side) is where the
// camera cannot tell "dropped in" from "held just above the rim".
function zone(b: Box, parcel: Box, band: number): Zone {
  const [x, y] = center(b);
  const mx = (parcel[2] - parcel[0]) * band;
  const my = (parcel[3] - parcel[1]) * band;
  const within = (x1: number, y1: number, x2: number, y2: number) => x >= x1 && x <= x2 && y >= y1 && y <= y2;
  if (within(parcel[0] + mx, parcel[1] + my, parcel[2] - mx, parcel[3] - my)) return 'inside';
  if (within(parcel[0] - mx, parcel[1] - my, parcel[2] + mx, parcel[3] + my)) return 'edge';
  return 'outside';
}

// SAM keeps an id while an object stays in view, but hands and box walls hide
// items, and a re-found item gets a new id. Join a track onto the one that
// ended just before it, close by, so one buckle is not counted twice.
function tracks(hits: Hit[], gap: number): Hit[][] {
  const byId = new Map<number, Hit[]>();
  for (const h of hits) byId.set(h.id, [...(byId.get(h.id) ?? []), h]);
  const list = [...byId.values()].map((t) => t.sort((a, b) => a.frame - b.frame)).sort((a, b) => a[0].frame - b[0].frame);
  const merged: Hit[][] = [];
  for (const t of list) {
    const prev = merged.find((m) => {
      const last = m.at(-1)!;
      const [ax, ay] = center(last.box);
      const [bx, by] = center(t[0].box);
      const dt = t[0].frame - last.frame;
      return dt > 0 && dt <= gap && Math.hypot(ax - bx, ay - by) <= size(last.box);
    });
    if (prev) prev.push(...t);
    else merged.push(t);
  }
  return merged;
}

// Frames where an item track starts or ends inside the clip: the moments an item
// appeared, vanished into packaging, or left. Muse Spark gets extra frames here.
export function trackEdges(itemHits: Hit[], totalFrames: number, gap = 4): number[] {
  const edges = tracks(itemHits, gap).flatMap((t) => [t[0].frame, t.at(-1)!.frame]);
  return [...new Set(edges)].filter((f) => f > 0 && f < totalFrames - 1).sort((a, b) => a - b);
}

// Which frames Muse Spark sees: one per second, plus every frame within `window`
// of a track edge, capped to keep cost down.
export function pickFrames(totalFrames: number, fps: number, edges: number[], window = 3, cap = 45): number[] {
  const picked = new Set<number>();
  for (let f = 0; f < totalFrames; f += fps) picked.add(f);
  for (const e of edges) {
    for (let f = e - window; f <= e + window; f++) {
      if (f >= 0 && f < totalFrames && picked.size < cap) picked.add(f);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

export function packEvents(itemHits: Hit[], parcel: Box | ((frame: number) => Box | null), opts: { totalFrames: number; band?: number; gap?: number; settle?: number }): PackEvent[] {
  const { totalFrames, band = 0.1, gap = 4, settle = 3 } = opts;
  const parcelAt = typeof parcel === 'function' ? parcel : () => parcel;
  const events: PackEvent[] = [];
  for (const t of tracks(itemHits, gap)) {
    const zones = t.map((h) => {
      const p = parcelAt(h.frame);
      return p ? zone(h.box, p, band) : 'outside';
    });
    const lastInside = zones.lastIndexOf('inside');
    const last = t.at(-1)!;
    const endsAtClipEnd = last.frame >= totalFrames - 1;
    if (lastInside === -1) {
      // Never clearly inside. Vanishing at the rim might be a drop we could not see.
      if (zones.at(-1) === 'edge' && !endsAtClipEnd) events.push({ kind: 'uncertain', frame: last.frame, why: 'lost at the parcel edge' });
      continue;
    }
    const after = zones.slice(lastInside + 1);
    events.push({ kind: 'in', frame: t[lastInside].frame, why: 'seen inside the parcel' });
    if (after.length === 0 || after.every((z) => z !== 'outside')) {
      if (after.includes('edge') && !endsAtClipEnd) events.push({ kind: 'uncertain', frame: last.frame, why: 'last seen on the rim' });
      continue;
    }
    const outsideFrames = after.filter((z) => z === 'outside').length;
    if (zones.at(-1) === 'outside' && (outsideFrames >= settle || endsAtClipEnd)) {
      events.push({ kind: 'out', frame: last.frame, why: 'left the parcel and stayed out' });
    } else {
      events.push({ kind: 'uncertain', frame: last.frame, why: 'moved out briefly, ending unclear' });
    }
  }
  return events.sort((a, b) => a.frame - b.frame);
}

export function verdict(events: PackEvent[], expected: number): { verdict: Verdict; net: number } {
  const net = events.filter((e) => e.kind === 'in').length - events.filter((e) => e.kind === 'out').length;
  if (events.some((e) => e.kind === 'uncertain')) return { verdict: 'uncertain', net };
  return { verdict: net === expected ? 'consistent' : 'mismatch', net };
}
