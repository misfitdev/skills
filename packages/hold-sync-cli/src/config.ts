import { readFileSync } from "node:fs";

export type Config = {
  mappings: Mapping[];
  hold?: {
    summary?: string;
    visibility?: "private";
    transparency?: "busy";
    notifications?: "none";
    reminders?: "none";
  };
  metadata?: {
    format?: "SYNCV1";
    encoding?: "base64url(json)";
    fields?: string[];
  };
  scheduling?: {
    reconcileCron?: string;
    daytimeCron?: string;
    driftWindowDays?: number;
    watchIntervalSeconds?: number;
  };
  safety?: {
    dryRun?: boolean;
    maxChangesPerRun?: number;
    excludeIfSummaryMatches?: string[];
    excludeIfDescriptionPrefix?: string[];
  };
  gog?: {
    allowCustomCommands?: boolean;
    listEventsCmd?: string;
    createEventCmd?: string;
    updateEventCmd?: string;
    deleteEventCmd?: string;
  };
};

export type Mapping = {
  name: string;
  targetAccount: string;
  targetCalendarId?: string;
  sources: Array<{ account: string; calendarId: string }>;
  lookaheadDays?: number;
  allDayMode?: "ignore" | "mirror";
  overlapPolicy?: "skip" | "allow";
};

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Config;
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  const commandKeys = ["listEventsCmd", "createEventCmd", "updateEventCmd", "deleteEventCmd"] as const;

  if (!Array.isArray(config.mappings) || config.mappings.length === 0) {
    errors.push("config.mappings must be a non-empty array");
    return errors;
  }

  const names = new Set<string>();
  for (const [index, mapping] of config.mappings.entries()) {
    if (!mapping.name) {
      errors.push(`mappings[${index}].name is required`);
    } else if (names.has(mapping.name)) {
      errors.push(`mappings[${index}].name must be unique: ${mapping.name}`);
    } else {
      names.add(mapping.name);
    }

    if (!mapping.targetAccount) {
      errors.push(`mappings[${index}].targetAccount is required`);
    }

    if (!Array.isArray(mapping.sources) || mapping.sources.length === 0) {
      errors.push(`mappings[${index}].sources must be a non-empty array`);
    } else {
      for (const [sourceIndex, source] of mapping.sources.entries()) {
        if (!source.account) {
          errors.push(`mappings[${index}].sources[${sourceIndex}].account is required`);
        }
        if (!source.calendarId) {
          errors.push(`mappings[${index}].sources[${sourceIndex}].calendarId is required`);
        }
      }
    }

    if (mapping.lookaheadDays !== undefined && mapping.lookaheadDays < 1) {
      errors.push(`mappings[${index}].lookaheadDays must be >= 1`);
    }

    if (mapping.allDayMode && !["ignore", "mirror"].includes(mapping.allDayMode)) {
      errors.push(`mappings[${index}].allDayMode must be ignore|mirror`);
    }

    if (mapping.overlapPolicy && !["skip", "allow"].includes(mapping.overlapPolicy)) {
      errors.push(`mappings[${index}].overlapPolicy must be skip|allow`);
    }
  }

  if (config.safety?.maxChangesPerRun !== undefined && config.safety.maxChangesPerRun < 1) {
    errors.push("safety.maxChangesPerRun must be >= 1");
  }

  if (config.scheduling?.watchIntervalSeconds !== undefined && config.scheduling.watchIntervalSeconds < 5) {
    errors.push("scheduling.watchIntervalSeconds must be >= 5");
  }

  for (const [index, pattern] of (config.safety?.excludeIfSummaryMatches ?? []).entries()) {
    if (pattern.length > 512) {
      errors.push(`safety.excludeIfSummaryMatches[${index}] exceeds max length (512)`);
      continue;
    }
    try {
      // Validate configured regex patterns early instead of crashing at runtime.
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`safety.excludeIfSummaryMatches[${index}] is invalid regex: ${message}`);
    }
  }

  if (config.gog?.allowCustomCommands !== true) {
    for (const key of commandKeys) {
      if (config.gog?.[key]) {
        errors.push(`gog.${key} requires gog.allowCustomCommands=true`);
      }
    }
  }

  if (config.gog?.allowCustomCommands === true) {
    for (const key of commandKeys) {
      const cmd = config.gog?.[key];
      if (!cmd) {
        continue;
      }
      if (!cmd.trim().startsWith("gog ")) {
        errors.push(`gog.${key} must start with 'gog '`);
      }
    }
  }

  return errors;
}
