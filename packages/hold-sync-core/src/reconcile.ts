import { Store } from "@tanstack/store";
import { decodeSourceRef, holdKey } from "./metadata.js";
import { isOverlap } from "./overlap.js";
import type { DesiredHold, GogEvent, OverlapPolicy, ReconcilePlan } from "./types.js";

function isEquivalent(existing: GogEvent, desired: GogEvent): boolean {
  return (
    existing.summary === desired.summary &&
    existing.description === desired.description &&
    existing.visibility === desired.visibility &&
    existing.transparency === desired.transparency &&
    existing.start.dateTime === desired.start.dateTime &&
    existing.start.date === desired.start.date &&
    existing.end.dateTime === desired.end.dateTime &&
    existing.end.date === desired.end.date
  );
}

function splitManaged(targetEvents: GogEvent[]): { managed: GogEvent[]; unmanaged: GogEvent[] } {
  const managed: GogEvent[] = [];
  const unmanaged: GogEvent[] = [];

  for (const event of targetEvents) {
    if (decodeSourceRef(event.description)) {
      managed.push(event);
      continue;
    }
    unmanaged.push(event);
  }

  return { managed, unmanaged };
}

export function planReconcile(args: {
  desiredHolds: DesiredHold[];
  targetEvents: GogEvent[];
  overlapPolicy: OverlapPolicy;
  maxChangesPerRun: number;
}): ReconcilePlan {
  const { desiredHolds, targetEvents, overlapPolicy, maxChangesPerRun } = args;
  const { managed, unmanaged } = splitManaged(targetEvents);

  const managedByKey = new Map<string, GogEvent[]>();
  for (const event of managed.sort((a, b) => a.id.localeCompare(b.id))) {
    const source = decodeSourceRef(event.description);
    if (!source) {
      continue;
    }
    const key = holdKey(source);
    const list = managedByKey.get(key) ?? [];
    list.push(event);
    managedByKey.set(key, list);
  }

  const desiredByKey = new Map<string, DesiredHold>();
  for (const desired of desiredHolds) {
    desiredByKey.set(holdKey(desired.source), desired);
  }

  const state = new Store<{
    actions: ReconcilePlan["actions"];
    changes: number;
    capped: boolean;
  }>({
    actions: [],
    changes: 0,
    capped: false
  });

  for (const key of [...desiredByKey.keys()].sort()) {
    const desired = desiredByKey.get(key);
    if (!desired) {
      continue;
    }

    const existingList = managedByKey.get(key) ?? [];
    if (existingList.length === 0) {
      if (overlapPolicy === "skip") {
        const blocker = unmanaged.find((candidate) => isOverlap(candidate, desired.event));
        if (blocker) {
          state.setState((prev) => ({
            ...prev,
            actions: [...prev.actions, { type: "skip_overlap", desired, blockingEventId: blocker.id }]
          }));
          continue;
        }
      }
      if (state.state.changes >= maxChangesPerRun) {
        state.setState((prev) => ({ ...prev, capped: true }));
        continue;
      }
      state.setState((prev) => ({
        ...prev,
        actions: [...prev.actions, { type: "create", desired }],
        changes: prev.changes + 1
      }));
      continue;
    }

    const [primary, ...duplicates] = existingList;
    if (!primary) {
      continue;
    }
    if (!isEquivalent(primary, desired.event)) {
      if (state.state.changes >= maxChangesPerRun) {
        state.setState((prev) => ({ ...prev, capped: true }));
      } else {
        state.setState((prev) => ({
          ...prev,
          actions: [...prev.actions, { type: "update", existing: primary, desired }],
          changes: prev.changes + 1
        }));
      }
    }

    for (const duplicate of duplicates) {
      if (state.state.changes >= maxChangesPerRun) {
        state.setState((prev) => ({ ...prev, capped: true }));
        continue;
      }
      state.setState((prev) => ({
        ...prev,
        actions: [...prev.actions, { type: "delete", existing: duplicate }],
        changes: prev.changes + 1
      }));
    }
  }

  for (const key of [...managedByKey.keys()].sort()) {
    if (desiredByKey.has(key)) {
      continue;
    }

    for (const stale of managedByKey.get(key) ?? []) {
      if (state.state.changes >= maxChangesPerRun) {
        state.setState((prev) => ({ ...prev, capped: true }));
        continue;
      }
      state.setState((prev) => ({
        ...prev,
        actions: [...prev.actions, { type: "delete", existing: stale }],
        changes: prev.changes + 1
      }));
    }
  }

  return {
    actions: state.state.actions,
    desiredCount: desiredHolds.length,
    existingManagedCount: managed.length,
    capped: state.state.capped
  };
}
