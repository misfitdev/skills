# AI Skills Monorepo

Cross-LLM skills monorepo for reusable skill logic and provider-specific skill instructions.

## Supported Skill Targets

- OpenClaw
- Claude Code
- Gemini
- Codex

Provider-specific `SKILL.md` variants are generated from a shared base + provider overlays.

## Stack

- Monorepo orchestration: `moon`
- Package manager/runtime/scripts: `bun`
- Foundational state model: TanStack (`@tanstack/store`)
- Language: TypeScript

## Repository Layout

- `packages/hold-sync-core`: Shared calendar hold reconcile engine and tests.
- `packages/hold-sync-cli`: `hold-sync` CLI (`validate-config`, `reconcile`, `backfill`, `status`, `install-cron`, `watch`).
- `packages/skill-build`: Skill variant generator (base + providers -> `dist/*/SKILL.md`).
- `skills/calendar-hold-sync`: Skill source, provider overlays, sample config, generated variants.

## Quick Start

```bash
bun install
bun run build
bun run test
bun run lint
bun run skill:build
```

## Moon Tasks

Run across all projects:

```bash
moon run :build
moon run :test
moon run :lint
```

Build skill variants:

```bash
moon run skill-build:build-skill
```

## Install a Skill Variant

Each skill has provider-specific output in `skills/<skill-name>/dist/<provider>/SKILL.md`.

For `calendar-hold-sync`:

- Codex: `skills/calendar-hold-sync/dist/codex/SKILL.md`
- Claude Code: `skills/calendar-hold-sync/dist/claude/SKILL.md`
- Gemini: `skills/calendar-hold-sync/dist/gemini/SKILL.md`
- OpenClaw: `skills/calendar-hold-sync/dist/openclaw/SKILL.md`

Then place the selected `SKILL.md` in that platform's skill installation location.

## Current Skills

- `calendar-hold-sync`: mirror source Google Calendar events to private Busy holds in target calendars using `gog`.

## Attribution

- `gog` setup guidance used by `calendar-hold-sync` docs is adapted from steipete's `gog` skill and official project docs:
  - https://clawhub.ai/steipete/gog
  - https://github.com/steipete/gogcli
  - https://gogcli.sh/

## Thanks

Thanks to the maintainer behind `gog` and OpenClaw, `@steipete`, for building and sharing these tools.

## Grimey Pass

[![Grimey Pass](assets/images/grimey-pass.png)](https://github.com/misfitdev/claude-plugins/tree/main/plugins/frank-grimes)
