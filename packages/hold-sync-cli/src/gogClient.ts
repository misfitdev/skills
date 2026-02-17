import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GogEvent } from "@ai-skills/hold-sync-core";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

function applyTemplate(template: string, args: Record<string, string>): string {
  return template.replaceAll(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => args[key] ?? "");
}

function splitCommand(command: string): { bin: string; args: string[] } {
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const cleaned = parts.map((part) => part.replace(/^"|"$/g, ""));
  const [bin, ...args] = cleaned;
  if (!bin) {
    throw new Error(`Invalid command: ${command}`);
  }
  return { bin, args };
}

async function runJson(command: string): Promise<any> {
  const { bin, args } = splitCommand(command);
  const { stdout, stderr } = await execFileAsync(bin, args);
  const text = stdout.trim();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse gog JSON output. stderr=${stderr.trim()} output=${text} err=${String(error)}`);
  }
}

function quoteArg(value: string): string {
  return JSON.stringify(value);
}

function normalizeEventTimes(event: GogEvent): { from: string; to: string; allDayFlag: string } {
  if (event.start.dateTime && event.end.dateTime) {
    return {
      from: event.start.dateTime,
      to: event.end.dateTime,
      allDayFlag: ""
    };
  }
  if (event.start.date && event.end.date) {
    return {
      from: event.start.date,
      to: event.end.date,
      allDayFlag: "--all-day"
    };
  }
  throw new Error(`Event ${event.id} is missing supported start/end fields`);
}

const DEFAULTS = {
  listEventsCmd:
    "gog calendar events {calendarId} --account {account} --from {timeMin} --to {timeMax} --json",
  createEventCmd:
    "gog calendar create {calendarId} --account {account} --summary {summary} --from {from} --to {to} --description {description} --visibility {visibility} --transparency {transparency} --send-updates none {allDayFlag} --json",
  updateEventCmd:
    "gog calendar update {calendarId} {eventId} --account {account} --summary {summary} --from {from} --to {to} --description {description} --visibility {visibility} --transparency {transparency} {allDayFlag} --json",
  deleteEventCmd:
    "gog calendar delete {calendarId} {eventId} --account {account} --force --json"
};

export class GogClient {
  constructor(private readonly config: Config) {}

  private template(name: keyof typeof DEFAULTS): string {
    const override = this.config.gog?.[name];
    if (!override) {
      return DEFAULTS[name];
    }
    if (this.config.gog?.allowCustomCommands !== true) {
      throw new Error(`gog.${name} override requires gog.allowCustomCommands=true`);
    }
    if (!override.trim().startsWith("gog ")) {
      throw new Error(`gog.${name} must start with 'gog '`);
    }
    return override;
  }

  async listEvents(args: {
    account: string;
    calendarId: string;
    timeMin: string;
    timeMax: string;
  }): Promise<GogEvent[]> {
    const command = applyTemplate(this.template("listEventsCmd"), args);
    const out = await runJson(command);
    if (Array.isArray(out)) {
      return out as GogEvent[];
    }
    return (out.items ?? out.events ?? []) as GogEvent[];
  }

  async createEvent(args: { account: string; calendarId: string; event: GogEvent }): Promise<void> {
    const times = normalizeEventTimes(args.event);
    const command = applyTemplate(this.template("createEventCmd"), {
      account: args.account,
      calendarId: args.calendarId,
      summary: quoteArg(args.event.summary ?? "Busy"),
      description: quoteArg(args.event.description ?? ""),
      visibility: args.event.visibility ?? "private",
      transparency: args.event.transparency ?? "busy",
      from: times.from,
      to: times.to,
      allDayFlag: times.allDayFlag
    });
    await runJson(command);
  }

  async updateEvent(args: { account: string; calendarId: string; eventId: string; event: GogEvent }): Promise<void> {
    const times = normalizeEventTimes(args.event);
    const command = applyTemplate(this.template("updateEventCmd"), {
      account: args.account,
      calendarId: args.calendarId,
      eventId: args.eventId,
      summary: quoteArg(args.event.summary ?? "Busy"),
      description: quoteArg(args.event.description ?? ""),
      visibility: args.event.visibility ?? "private",
      transparency: args.event.transparency ?? "busy",
      from: times.from,
      to: times.to,
      allDayFlag: times.allDayFlag
    });
    await runJson(command);
  }

  async deleteEvent(args: { account: string; calendarId: string; eventId: string }): Promise<void> {
    const command = applyTemplate(this.template("deleteEventCmd"), args);
    await runJson(command);
  }
}
