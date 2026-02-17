import type { GogEvent } from "./types.js";

function parseIso(value: string): number {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) {
    throw new Error(`Invalid date value: ${value}`);
  }
  return ts;
}

export function eventRange(event: GogEvent): { startMs: number; endMs: number } {
  if (event.start.dateTime && event.end.dateTime) {
    return { startMs: parseIso(event.start.dateTime), endMs: parseIso(event.end.dateTime) };
  }

  if (event.start.date && event.end.date) {
    return {
      startMs: parseIso(`${event.start.date}T00:00:00.000Z`),
      endMs: parseIso(`${event.end.date}T00:00:00.000Z`)
    };
  }

  throw new Error(`Event ${event.id} is missing supported start/end fields`);
}

export function isOverlap(a: GogEvent, b: GogEvent): boolean {
  const x = eventRange(a);
  const y = eventRange(b);
  return x.startMs < y.endMs && y.startMs < x.endMs;
}
