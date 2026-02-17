import { Buffer } from "node:buffer";
import type { SourceRef } from "./types.js";

export const METADATA_PREFIX = "SYNCV1:";

export function encodeSourceRef(source: SourceRef): string {
  return `${METADATA_PREFIX}${Buffer.from(JSON.stringify(source), "utf8").toString("base64url")}`;
}

export function decodeSourceRef(description?: string): SourceRef | null {
  if (!description) {
    return null;
  }
  const index = description.indexOf(METADATA_PREFIX);
  if (index < 0) {
    return null;
  }

  const encoded = description.slice(index + METADATA_PREFIX.length).trim();
  if (!encoded) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SourceRef>;
    if (
      typeof parsed.srcAccount !== "string" ||
      typeof parsed.srcCalendar !== "string" ||
      typeof parsed.eventId !== "string" ||
      typeof parsed.start !== "string" ||
      typeof parsed.end !== "string" ||
      typeof parsed.title !== "string"
    ) {
      return null;
    }
    return parsed as SourceRef;
  } catch {
    return null;
  }
}

export function holdKey(source: SourceRef): string {
  return `${source.srcAccount}::${source.srcCalendar}::${source.eventId}::${source.start}::${source.end}`;
}
