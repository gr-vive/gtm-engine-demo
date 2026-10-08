# gtm-engine-demo

Growth engine for a fictional UK specialist lender (Lodestar Legal Finance). Synthetic data only. Built as an interview portfolio piece; the architecture mirrors production systems.

## Session Start

1. Read this file and `README.md`.
2. Health check: `node_modules/` exists (`npm install`), `node --version` ≥ 22.13.
3. Present the menu:

```
[A] Run the whole demo           npm run demo
[B] Run one module               node bin/gtm.js audience run | attribution run | report weekly | ai triage
[C] Rebuild the dashboard        node bin/gtm.js report dashboard  (preview: launch "gtm-dashboard" on :8766)
[D] Tests                        npm test
[E] Change the world             edit scripts/seed.js or SEED in .env, then npm run seed
```

## Rules

- All code, docs and output in English. UK spelling in user-facing text.
- Never commit `.env`, `data/gtm.db`, `runs/`, `logs/`, `reports/**/*.json`.
- Never add a mode that sends anything to a customer. `AI_MODE` is `shadow` or `assist` only.
- Rules decide, models read. Do not move routing logic into prompts.
- Keep the demo under ten seconds. Measure with `npm run demo` (timings print at the end).
- Fixtures under `data/fixtures/` are cached real model responses; do not hand-edit them.

## Quick Reference

| Action | Command |
|---|---|
| Everything | `npm run demo` |
| Seed only | `npm run seed` |
| Audience pipeline / resume / status | `node bin/gtm.js audience run` · `audience resume --run-id <id>` · `audience status` |
| Attribution | `node bin/gtm.js attribution run` |
| Weekly numbers / Slack / dashboard | `node bin/gtm.js report weekly [--week YYYY-MM-DD]` · `report digest` · `report dashboard` |
| AI triage (shadow) / eval / audit | `node bin/gtm.js ai triage [--live]` · `ai shadow-eval` · `ai audit <enquiry_id>` |
| Schedule | `node bin/gtm.js schedule [--run=<task>] [--daemon]` |
| Tests | `npm test` |

## Scenarios

- **Numbers look wrong:** `node bin/gtm.js status` for counts, then `npm run seed` to rebuild; everything is deterministic from `SEED`.
- **Add a channel:** add it to `LENDER.channels` in `lib/config.js`, give it spend and touches in `scripts/seed.js`, and a UTM shape in the `UTM` map.
- **Add a rule:** edit `scripts/ai-layer/rules.js`, bump `RULES_VERSION`, add a test in `test/rules.test.js`.
- **Change the prompt:** edit `systemPrompt()` in `scripts/ai-layer/extract.js`, bump `PROMPT_VERSION` in `lib/config.js`; old decisions stay comparable.
- **Real model calls:** put `ANTHROPIC_API_KEY` in `.env`, run `node bin/gtm.js ai triage --live`; responses cache to `data/fixtures/`.

## Architecture

See `README.md` (overview), `docs/ARCHITECTURE.md` (data model, modules, integrations), `docs/RUNBOOK.md` (failure modes), `docs/decisions/` (ADRs).
