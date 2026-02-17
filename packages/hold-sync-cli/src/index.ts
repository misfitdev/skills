#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { Store } from "@tanstack/store";
import {
  decodeSourceRef,
  encodeSourceRef,
  planReconcile,
  type DesiredHold,
  type GogEvent,
  type SourceRef
} from "@ai-skills/hold-sync-core";
import { loadConfig, validateConfig, type Config, type Mapping } from "./config.js";
import { GogClient } from "./gogClient.js";

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function plusDaysIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isAllDay(event: GogEvent): boolean {
  return Boolean(event.start.date && event.end.date);
}

function matchesAnyPattern(input: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(input));
}

function excludedBySafety(event: GogEvent, config: Config): boolean {
  const summary = event.summary ?? "";
  const description = event.description ?? "";
  const summaryPatterns = config.safety?.excludeIfSummaryMatches ?? [];
  const descriptionPrefixes = config.safety?.excludeIfDescriptionPrefix ?? [];

  if (summaryPatterns.length > 0 && matchesAnyPattern(summary, summaryPatterns)) {
    return true;
  }

  if (descriptionPrefixes.some((prefix) => description.startsWith(prefix))) {
    return true;
  }

  return false;
}

function normalizeMapping(mapping: Mapping): Required<Mapping> {
  return {
    ...mapping,
    targetCalendarId: mapping.targetCalendarId ?? "primary",
    lookaheadDays: mapping.lookaheadDays ?? 30,
    allDayMode: mapping.allDayMode ?? "ignore",
    overlapPolicy: mapping.overlapPolicy ?? "skip"
  };
}

function desiredHoldFromSource(sourceAccount: string, sourceCalendar: string, sourceEvent: GogEvent, config: Config): DesiredHold {
  const src: SourceRef = {
    srcAccount: sourceAccount,
    srcCalendar: sourceCalendar,
    eventId: sourceEvent.id,
    start: sourceEvent.start.dateTime ?? `${sourceEvent.start.date}T00:00:00.000Z`,
    end: sourceEvent.end.dateTime ?? `${sourceEvent.end.date}T00:00:00.000Z`,
    title: sourceEvent.summary ?? ""
  };

  return {
    source: src,
    event: {
      id: `hold-${sourceEvent.id}`,
      summary: config.hold?.summary ?? "Busy",
      visibility: "private",
      transparency: "busy",
      description: encodeSourceRef(src),
      start: sourceEvent.start,
      end: sourceEvent.end,
      reminders: { useDefault: false, overrides: [] }
    }
  };
}

async function collectDesiredHolds(client: GogClient, mapping: Required<Mapping>, config: Config): Promise<DesiredHold[]> {
  return collectDesiredHoldsInWindow(client, mapping, config, nowIso(), plusDaysIso(mapping.lookaheadDays));
}

async function collectDesiredHoldsInWindow(
  client: GogClient,
  mapping: Required<Mapping>,
  config: Config,
  windowStart: string,
  windowEnd: string
): Promise<DesiredHold[]> {
  const holds: DesiredHold[] = [];
  for (const source of mapping.sources) {
    const events = await client.listEvents({
      account: source.account,
      calendarId: source.calendarId,
      timeMin: windowStart,
      timeMax: windowEnd
    });

    for (const event of events) {
      if (event.status === "cancelled") {
        continue;
      }
      if (mapping.allDayMode === "ignore" && isAllDay(event)) {
        continue;
      }
      if (excludedBySafety(event, config)) {
        continue;
      }
      holds.push(desiredHoldFromSource(source.account, source.calendarId, event, config));
    }
  }

  return holds;
}

function selectMappings(config: Config, mappingName: string | undefined, all: boolean): Required<Mapping>[] {
  const normalized = config.mappings.map(normalizeMapping);

  if (all) {
    return normalized;
  }
  if (!mappingName) {
    throw new Error("Select one mapping with --mapping <name> or use --all");
  }

  const found = normalized.find((mapping) => mapping.name === mappingName);
  if (!found) {
    throw new Error(`Unknown mapping: ${mappingName}`);
  }
  return [found];
}

async function executePlan(args: {
  client: GogClient;
  mapping: Required<Mapping>;
  config: Config;
  dryRun: boolean;
  desiredHolds?: DesiredHold[];
}): Promise<{ creates: number; updates: number; deletes: number; skipped: number; capped: boolean }> {
  const { client, mapping, config, dryRun } = args;
  const desired = args.desiredHolds ?? (await collectDesiredHolds(client, mapping, config));

  const targetEvents = await client.listEvents({
    account: mapping.targetAccount,
    calendarId: mapping.targetCalendarId,
    timeMin: nowIso(),
    timeMax: plusDaysIso(mapping.lookaheadDays)
  });

  const plan = planReconcile({
    desiredHolds: desired,
    targetEvents,
    overlapPolicy: mapping.overlapPolicy,
    maxChangesPerRun: config.safety?.maxChangesPerRun ?? 100
  });

  const counters = new Store({ creates: 0, updates: 0, deletes: 0, skipped: 0 });

  for (const action of plan.actions) {
    if (action.type === "skip_overlap") {
      counters.setState((state) => ({ ...state, skipped: state.skipped + 1 }));
      continue;
    }

    if (action.type === "create") {
      counters.setState((state) => ({ ...state, creates: state.creates + 1 }));
      if (!dryRun) {
        await client.createEvent({
          account: mapping.targetAccount,
          calendarId: mapping.targetCalendarId,
          event: action.desired.event
        });
      }
      continue;
    }

    if (action.type === "update") {
      counters.setState((state) => ({ ...state, updates: state.updates + 1 }));
      if (!dryRun) {
        await client.updateEvent({
          account: mapping.targetAccount,
          calendarId: mapping.targetCalendarId,
          eventId: action.existing.id,
          event: action.desired.event
        });
      }
      continue;
    }

    counters.setState((state) => ({ ...state, deletes: state.deletes + 1 }));
    if (!dryRun) {
      await client.deleteEvent({
        account: mapping.targetAccount,
        calendarId: mapping.targetCalendarId,
        eventId: action.existing.id
      });
    }
  }

  return { ...counters.state, capped: plan.capped };
}

async function backfill(args: {
  client: GogClient;
  mapping: Required<Mapping>;
  config: Config;
  dryRun: boolean;
}): Promise<{ updated: number }> {
  const { client, mapping, config, dryRun } = args;
  const lookahead = config.scheduling?.driftWindowDays ?? mapping.lookaheadDays;
  const windowStart = nowIso();
  const windowEnd = plusDaysIso(lookahead);

  const sourceEvents: Array<{ account: string; calendarId: string; event: GogEvent }> = [];
  for (const source of mapping.sources) {
    const events = await client.listEvents({
      account: source.account,
      calendarId: source.calendarId,
      timeMin: windowStart,
      timeMax: windowEnd
    });
    for (const event of events) {
      if (event.status === "cancelled") {
        continue;
      }
      if (mapping.allDayMode === "ignore" && isAllDay(event)) {
        continue;
      }
      if (excludedBySafety(event, config)) {
        continue;
      }
      sourceEvents.push({ account: source.account, calendarId: source.calendarId, event });
    }
  }

  const sourceByRange = new Map<string, Array<{ account: string; calendarId: string; event: GogEvent }>>();
  for (const src of sourceEvents) {
    const key = `${src.event.start.dateTime ?? src.event.start.date}|${src.event.end.dateTime ?? src.event.end.date}`;
    const list = sourceByRange.get(key) ?? [];
    list.push(src);
    sourceByRange.set(key, list);
  }

  const targetEvents = await client.listEvents({
    account: mapping.targetAccount,
    calendarId: mapping.targetCalendarId,
    timeMin: windowStart,
    timeMax: windowEnd
  });

  let updated = 0;
  for (const target of targetEvents) {
    if (decodeSourceRef(target.description)) {
      continue;
    }
    if ((target.summary ?? "") !== (config.hold?.summary ?? "Busy")) {
      continue;
    }
    if (excludedBySafety(target, config)) {
      continue;
    }
    if ((target.visibility ?? "default") !== "private") {
      continue;
    }
    if ((target.transparency ?? "opaque") !== "busy") {
      continue;
    }
    if (target.reminders?.overrides && target.reminders.overrides.length > 0) {
      continue;
    }

    const key = `${target.start.dateTime ?? target.start.date}|${target.end.dateTime ?? target.end.date}`;
    const candidates = sourceByRange.get(key) ?? [];
    if (candidates.length !== 1) {
      continue;
    }

    const candidate = candidates[0];
    if (!candidate) {
      continue;
    }
    const sourceRef: SourceRef = {
      srcAccount: candidate.account,
      srcCalendar: candidate.calendarId,
      eventId: candidate.event.id,
      start: candidate.event.start.dateTime ?? `${candidate.event.start.date}T00:00:00.000Z`,
      end: candidate.event.end.dateTime ?? `${candidate.event.end.date}T00:00:00.000Z`,
      title: candidate.event.summary ?? ""
    };

    updated += 1;
    if (!dryRun) {
      await client.updateEvent({
        account: mapping.targetAccount,
        calendarId: mapping.targetCalendarId,
        eventId: target.id,
        event: {
          ...target,
          description: encodeSourceRef(sourceRef),
          visibility: "private",
          transparency: "busy",
          reminders: { useDefault: false, overrides: [] }
        }
      });
    }
  }

  return { updated };
}

function installCron(args: { configPath: string; mappingNames: string[]; config: Config }): void {
  const nodePath = process.execPath;
  const cliPath = resolve(process.argv[1] ?? "hold-sync");
  const managedStart = "# BEGIN hold-sync managed";
  const managedEnd = "# END hold-sync managed";

  let current = "";
  try {
    current = execSync("crontab -l", { encoding: "utf8" });
  } catch {
    current = "";
  }

  const kept = current
    .split("\n")
    .filter((line) => !line.includes(managedStart) && !line.includes(managedEnd) && !line.includes("hold-sync reconcile"))
    .join("\n")
    .trim();

  const lines: string[] = [];
  lines.push(managedStart);
  for (const name of args.mappingNames) {
    const mapping = args.config.mappings.find((m) => m.name === name);
    if (!mapping) {
      continue;
    }
    const reconcileCron = args.config.scheduling?.reconcileCron ?? "15 2 * * *";
    lines.push(`${reconcileCron} ${nodePath} ${cliPath} --config ${args.configPath} reconcile --mapping ${name}`);

    const daytime = args.config.scheduling?.daytimeCron;
    if (daytime) {
      lines.push(`${daytime} ${nodePath} ${cliPath} --config ${args.configPath} reconcile --mapping ${name}`);
    }
  }
  lines.push(managedEnd);

  const next = [kept, lines.join("\n")].filter(Boolean).join("\n") + "\n";
  execSync("crontab -", { input: next });
}

function eventFingerprint(event: GogEvent): string {
  const versioned = event as GogEvent & { updated?: string; etag?: string };
  const start = event.start.dateTime ?? event.start.date ?? "";
  const end = event.end.dateTime ?? event.end.date ?? "";
  return [
    event.id,
    event.status ?? "",
    versioned.updated ?? "",
    versioned.etag ?? "",
    start,
    end,
    event.summary ?? ""
  ].join("|");
}

async function sourceSnapshot(
  client: GogClient,
  mapping: Required<Mapping>,
  config: Config
): Promise<{ signature: string; desiredHolds: DesiredHold[] }> {
  const timeMin = nowIso();
  const timeMax = plusDaysIso(mapping.lookaheadDays);
  const desiredHolds = await collectDesiredHoldsInWindow(client, mapping, config, timeMin, timeMax);
  const signatures: string[] = desiredHolds.map((hold) => {
    const event = hold.event;
    return `${hold.source.srcAccount}|${hold.source.srcCalendar}|${eventFingerprint(event)}`;
  });

  signatures.sort();
  return {
    signature: signatures.join("\n"),
    desiredHolds
  };
}

async function main(): Promise<void> {
  const program = new Command();
  program.name("hold-sync").description("Calendar hold sync CLI");

  program.option("--config <path>", "path to JSON config file", "./skills/calendar-hold-sync/config/sample.config.json");

  program
    .command("validate-config")
    .action(() => {
      const opts = program.opts<{ config: string }>();
      const config = loadConfig(opts.config);
      const errors = validateConfig(config);
      if (errors.length > 0) {
        for (const error of errors) {
          console.error(`ERROR: ${error}`);
        }
        process.exitCode = 1;
        return;
      }
      console.log("Config valid");
    });

  program
    .command("watch")
    .option("--mapping <name>", "mapping name")
    .option("--all", "run for all mappings", false)
    .option("--dry-run", "force dry-run", false)
    .option("--interval-seconds <n>", "poll interval in seconds")
    .option("--skip-initial", "do not run an immediate reconcile", false)
    .action(
      async (options: {
        mapping?: string;
        all: boolean;
        dryRun: boolean;
        intervalSeconds?: string;
        skipInitial: boolean;
      }) => {
        const opts = program.opts<{ config: string }>();
        const config = loadConfig(opts.config);
        const errors = validateConfig(config);
        if (errors.length > 0) {
          throw new Error(`Config invalid:\n${errors.join("\n")}`);
        }

        const mappings = selectMappings(config, options.mapping, options.all);
        const client = new GogClient(config);
        const dryRun = options.dryRun || Boolean(config.safety?.dryRun);
        const intervalSeconds = Number(options.intervalSeconds ?? config.scheduling?.watchIntervalSeconds ?? 20);
        if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) {
          throw new Error("watch interval must be a number >= 5 seconds");
        }

        const signatures = new Map<string, string>();
        const desiredByMapping = new Map<string, DesiredHold[]>();
        for (const mapping of mappings) {
          const snapshot = await sourceSnapshot(client, mapping, config);
          signatures.set(mapping.name, snapshot.signature);
          desiredByMapping.set(mapping.name, snapshot.desiredHolds);
        }

        if (!options.skipInitial) {
          for (const mapping of mappings) {
            const result = await executePlan({
              client,
              mapping,
              config,
              dryRun,
              desiredHolds: desiredByMapping.get(mapping.name) ?? []
            });
            console.log(
              `${mapping.name}: initial create=${result.creates} update=${result.updates} delete=${result.deletes} skip=${result.skipped} capped=${result.capped} dryRun=${dryRun}`
            );
          }
        }

        let running = true;
        process.on("SIGINT", () => {
          running = false;
        });
        process.on("SIGTERM", () => {
          running = false;
        });
        console.log(`watch started: mappings=${mappings.length} interval=${intervalSeconds}s dryRun=${dryRun}`);

        while (running) {
          for (const mapping of mappings) {
            try {
              const snapshot = await sourceSnapshot(client, mapping, config);
              const nextSignature = snapshot.signature;
              const previousSignature = signatures.get(mapping.name);
              if (nextSignature === previousSignature) {
                continue;
              }
              signatures.set(mapping.name, nextSignature);

              const result = await executePlan({
                client,
                mapping,
                config,
                dryRun,
                desiredHolds: snapshot.desiredHolds
              });
              console.log(
                `${mapping.name}: changed create=${result.creates} update=${result.updates} delete=${result.deletes} skip=${result.skipped} capped=${result.capped} dryRun=${dryRun}`
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`${mapping.name}: watch poll failed: ${message}`);
            }
          }

          await sleep(intervalSeconds * 1000);
        }

        console.log("watch stopped");
      }
    );

  for (const commandName of ["reconcile", "status", "backfill", "install-cron"]) {
    program
      .command(commandName)
      .option("--mapping <name>", "mapping name")
      .option("--all", "run for all mappings", false)
      .option("--dry-run", "force dry-run", false)
      .action(async (options: { mapping?: string; all: boolean; dryRun: boolean }) => {
        const opts = program.opts<{ config: string }>();
        const config = loadConfig(opts.config);
        const errors = validateConfig(config);
        if (errors.length > 0) {
          throw new Error(`Config invalid:\n${errors.join("\n")}`);
        }

        const mappings = selectMappings(config, options.mapping, options.all);
        const client = new GogClient(config);
        const dryRun = options.dryRun || Boolean(config.safety?.dryRun);

        if (commandName === "install-cron") {
          installCron({
            configPath: resolve(opts.config),
            mappingNames: mappings.map((mapping) => mapping.name),
            config
          });
          console.log(`Installed cron entries for ${mappings.length} mapping(s)`);
          return;
        }

        for (const mapping of mappings) {
          if (commandName === "reconcile") {
            const result = await executePlan({ client, mapping, config, dryRun });
            console.log(
              `${mapping.name}: create=${result.creates} update=${result.updates} delete=${result.deletes} skip=${result.skipped} capped=${result.capped} dryRun=${dryRun}`
            );
          }

          if (commandName === "status") {
            const status = await executePlan({ client, mapping, config, dryRun: true });
            console.log(
              `${mapping.name}: pendingCreate=${status.creates} pendingUpdate=${status.updates} pendingDelete=${status.deletes} skip=${status.skipped} capped=${status.capped}`
            );
          }

          if (commandName === "backfill") {
            const result = await backfill({ client, mapping, config, dryRun });
            console.log(`${mapping.name}: backfillUpdated=${result.updated} dryRun=${dryRun}`);
          }
        }
      });
  }

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
