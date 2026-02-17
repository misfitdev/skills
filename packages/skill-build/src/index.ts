import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function buildSkill(skillDir: string): void {
  const basePath = join(skillDir, "SKILL.base.md");
  const providersDir = join(skillDir, "providers");
  const distDir = join(skillDir, "dist");

  const base = readFileSync(basePath, "utf8").trim();
  const providers = readdirSync(providersDir).filter((file) => file.endsWith(".md")).sort();

  for (const providerFile of providers) {
    const providerName = basename(providerFile, ".md");
    const providerBody = readFileSync(join(providersDir, providerFile), "utf8").trim();
    const output = `---\nname: calendar-hold-sync\ndescription: Sync one or more source Google calendars into private Busy hold events in one or more target calendars using gog. Use when users need idempotent double-booking prevention, backfill of legacy holds, drift reconcile, or safe scheduled sync.\n---\n\n${base}\n\n## Provider Notes (${providerName})\n\n${providerBody}\n`;

    const providerOutDir = join(distDir, providerName);
    mkdirSync(providerOutDir, { recursive: true });
    writeFileSync(join(providerOutDir, "SKILL.md"), output);
  }
}

const inputDir = process.argv[2];
if (!inputDir) {
  throw new Error("Usage: tsx packages/skill-build/src/index.ts <skills/<name>>");
}

buildSkill(resolve(inputDir));
console.log(`Built skill variants in ${resolve(inputDir, "dist")}`);
