import { describe, expect, it } from "vitest";
import { decodeSourceRef, encodeSourceRef, isOverlap, planReconcile } from "../src/index.js";
import type { DesiredHold, GogEvent, SourceRef } from "../src/index.js";

function timedEvent(id: string, start: string, end: string, fields: Partial<GogEvent> = {}): GogEvent {
  return {
    id,
    start: { dateTime: start },
    end: { dateTime: end },
    ...fields
  };
}

describe("metadata encode/decode", () => {
  it("round-trips SYNCV1 payload", () => {
    const source: SourceRef = {
      srcAccount: "source@example.com",
      srcCalendar: "primary",
      eventId: "abc123",
      start: "2026-03-01T14:00:00.000Z",
      end: "2026-03-01T15:00:00.000Z",
      title: "Standup"
    };

    const encoded = encodeSourceRef(source);
    expect(encoded.startsWith("SYNCV1:")).toBe(true);
    expect(decodeSourceRef(encoded)).toEqual(source);
  });
});

describe("overlap detection", () => {
  it("detects partial overlap", () => {
    const a = timedEvent("a", "2026-03-01T10:00:00.000Z", "2026-03-01T11:00:00.000Z");
    const b = timedEvent("b", "2026-03-01T10:30:00.000Z", "2026-03-01T11:30:00.000Z");
    expect(isOverlap(a, b)).toBe(true);
  });

  it("does not overlap when touching boundaries", () => {
    const a = timedEvent("a", "2026-03-01T10:00:00.000Z", "2026-03-01T11:00:00.000Z");
    const b = timedEvent("b", "2026-03-01T11:00:00.000Z", "2026-03-01T12:00:00.000Z");
    expect(isOverlap(a, b)).toBe(false);
  });
});

describe("idempotent reconcile", () => {
  function desiredHold(source: SourceRef): DesiredHold {
    return {
      source,
      event: {
        id: `desired-${source.eventId}`,
        summary: "Busy",
        visibility: "private",
        transparency: "busy",
        description: encodeSourceRef(source),
        start: { dateTime: source.start },
        end: { dateTime: source.end },
        reminders: { useDefault: false, overrides: [] }
      }
    };
  }

  it("creates missing hold and deletes stale hold", () => {
    const src: SourceRef = {
      srcAccount: "source@example.com",
      srcCalendar: "work",
      eventId: "fresh",
      start: "2026-03-01T12:00:00.000Z",
      end: "2026-03-01T12:30:00.000Z",
      title: "1:1"
    };
    const stale: SourceRef = {
      srcAccount: "source@example.com",
      srcCalendar: "work",
      eventId: "stale",
      start: "2026-03-02T12:00:00.000Z",
      end: "2026-03-02T12:30:00.000Z",
      title: "Old"
    };

    const targetEvents: GogEvent[] = [
      timedEvent("managed-stale", stale.start, stale.end, {
        description: encodeSourceRef(stale),
        summary: "Busy",
        visibility: "private",
        transparency: "busy"
      })
    ];

    const plan = planReconcile({
      desiredHolds: [desiredHold(src)],
      targetEvents,
      overlapPolicy: "allow",
      maxChangesPerRun: 10
    });

    expect(plan.actions.map((a) => a.type).sort()).toEqual(["create", "delete"]);
  });

  it("updates drifted hold and is idempotent after update", () => {
    const src: SourceRef = {
      srcAccount: "source@example.com",
      srcCalendar: "work",
      eventId: "drifted",
      start: "2026-03-03T09:00:00.000Z",
      end: "2026-03-03T10:00:00.000Z",
      title: "Planning"
    };

    const desired = desiredHold(src);
    const driftedExisting = timedEvent("managed-1", src.start, src.end, {
      description: encodeSourceRef(src),
      summary: "Not Busy",
      visibility: "private",
      transparency: "busy"
    });

    const first = planReconcile({
      desiredHolds: [desired],
      targetEvents: [driftedExisting],
      overlapPolicy: "allow",
      maxChangesPerRun: 10
    });
    expect(first.actions.map((a) => a.type)).toEqual(["update"]);

    const second = planReconcile({
      desiredHolds: [desired],
      targetEvents: [desired.event],
      overlapPolicy: "allow",
      maxChangesPerRun: 10
    });
    expect(second.actions).toEqual([]);
  });
});
