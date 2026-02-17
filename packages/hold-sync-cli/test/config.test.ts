import { describe, expect, it } from "vitest";
import { validateConfig, type Config } from "../src/config.js";
import { GogClient } from "../src/gogClient.js";

function validConfig(): Config {
  return {
    mappings: [
      {
        name: "m1",
        targetAccount: "target@example.com",
        targetCalendarId: "primary",
        sources: [{ account: "src@example.com", calendarId: "primary" }],
        lookaheadDays: 1,
        allDayMode: "ignore",
        overlapPolicy: "skip"
      }
    ],
    safety: {
      dryRun: true,
      maxChangesPerRun: 10,
      excludeIfSummaryMatches: ["^OOO"],
      excludeIfDescriptionPrefix: ["MANUAL:"]
    },
    scheduling: {
      watchIntervalSeconds: 900
    }
  };
}

describe("validateConfig", () => {
  it("accepts valid baseline config", () => {
    expect(validateConfig(validConfig())).toEqual([]);
  });

  it("rejects invalid regex in summary patterns", () => {
    const config = validConfig();
    config.safety = {
      ...config.safety,
      excludeIfSummaryMatches: ["(invalid"]
    };

    const errors = validateConfig(config);
    expect(errors.some((error) => error.includes("invalid regex"))).toBe(true);
  });

  it("rejects too-fast watch interval", () => {
    const config = validConfig();
    config.scheduling = { watchIntervalSeconds: 3 };

    const errors = validateConfig(config);
    expect(errors).toContain("scheduling.watchIntervalSeconds must be >= 5");
  });

  it("rejects custom gog command overrides when allowCustomCommands is false", () => {
    const config = validConfig();
    config.gog = {
      listEventsCmd: "gog calendar events list --json"
    };

    const errors = validateConfig(config);
    expect(errors).toContain("gog.listEventsCmd requires gog.allowCustomCommands=true");
  });

  it("rejects custom command that does not start with gog", () => {
    const config = validConfig();
    config.gog = {
      allowCustomCommands: true,
      listEventsCmd: "curl https://example.com"
    };

    const errors = validateConfig(config);
    expect(errors).toContain("gog.listEventsCmd must start with 'gog '");
  });
});

describe("GogClient command guard", () => {
  it("throws when override exists without allowCustomCommands", async () => {
    const client = new GogClient({
      ...validConfig(),
      gog: {
        listEventsCmd: "gog calendar events list --json"
      }
    });

    await expect(
      client.listEvents({
        account: "a@example.com",
        calendarId: "primary",
        timeMin: "2026-01-01T00:00:00.000Z",
        timeMax: "2026-01-02T00:00:00.000Z"
      })
    ).rejects.toThrow("requires gog.allowCustomCommands=true");
  });
});
