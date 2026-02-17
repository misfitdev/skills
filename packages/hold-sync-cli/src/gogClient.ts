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

const DEFAULTS = {
  listEventsCmd:
    "gog calendar events list --account {account} --calendar-id {calendarId} --time-min {timeMin} --time-max {timeMax} --json",
  createEventCmd:
    "gog calendar events create --account {account} --calendar-id {calendarId} --event-json {eventJson} --json",
  updateEventCmd:
    "gog calendar events update --account {account} --calendar-id {calendarId} --event-id {eventId} --event-json {eventJson} --json",
  deleteEventCmd:
    "gog calendar events delete --account {account} --calendar-id {calendarId} --event-id {eventId} --json"
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
    return (out.items ?? out.events ?? []) as GogEvent[];
  }

  async createEvent(args: { account: string; calendarId: string; event: GogEvent }): Promise<void> {
    const eventJson = JSON.stringify(args.event);
    const command = applyTemplate(this.template("createEventCmd"), {
      account: args.account,
      calendarId: args.calendarId,
      eventJson
    });
    await runJson(command);
  }

  async updateEvent(args: { account: string; calendarId: string; eventId: string; event: GogEvent }): Promise<void> {
    const eventJson = JSON.stringify(args.event);
    const command = applyTemplate(this.template("updateEventCmd"), {
      account: args.account,
      calendarId: args.calendarId,
      eventId: args.eventId,
      eventJson
    });
    await runJson(command);
  }

  async deleteEvent(args: { account: string; calendarId: string; eventId: string }): Promise<void> {
    const command = applyTemplate(this.template("deleteEventCmd"), args);
    await runJson(command);
  }
}
