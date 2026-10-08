# gtm-engine-demo

The growth machinery for a fictional UK specialist lender, **Lodestar Legal Finance**, built the way I build it for real clients: small pieces, each with one owner, each producing a number someone works from, everything scheduled and logged.

It covers the four things a growth engineer owns at a lender:

| What it owns | Where | What it produces |
|---|---|---|
| **The audience**: law firms and the people in them, kept current and deliverable | `scripts/audience/` | a registry with a daily cursor, a capped push to the sequencer, reply and meeting statuses pulled back, buying signals |
| **Attribution**: first click to funded loan | `scripts/attribution/` | identity resolution, one journey per opportunity, five models, cost per funded loan by channel, next to what the CRM *thinks* |
| **One set of numbers**: the weekly funnel by product and channel | `scripts/reporting/` | a markdown report, a Slack digest, a dashboard page, all from the same query |
| **The AI capability layer** over inbound enquiries | `scripts/ai-layer/` | coded rules route and do the arithmetic, the model reads and drafts, a person decides, shadow mode gates promotion, an append-only audit log |

Everything is synthetic. Firms, people, spend, touches, Salesforce objects, loans and enquiry emails are generated from one integer seed, so the numbers in this README are the numbers you get when you run it.

## Run it

```bash
npm install
npm run demo        # the whole engine, end to end, about 5 seconds
```

Needs Node 22.13 or newer (SQLite is built in, there is nothing native to compile). No API keys are required: the model reader uses the cached Claude responses in `data/fixtures/`, and Slack delivery runs dry. Two optional keys make two parts live:

- `ANTHROPIC_API_KEY` and `gtm ai triage --live` re-read the enquiries with Claude and refresh the fixtures.
- `COMPANIES_HOUSE_API_KEY` (free, from the Companies House developer hub) makes the discover stage pull real solicitor firms and their officers from the public register instead of the mock sources.

What the demo prints, in order:

```
1 · Seed the world        708 firms, 1,798 contacts, 80,536 touches, 1,636 opportunities, 465 funded loans
2 · Audience              discover 45 → dedup 7 known → enrich → 17 qualified → 40 pushed (daily cap) · 199 waiting
3 · Attribution           1,151 anonymous ids resolved · 1,590 journeys · 5 models · cost per funded loan by channel
4 · One set of numbers    weekly funnel by product × channel · cohort view · trailing 12 weeks · Slack digest
5 · AI capability layer   240 enquiries read by Claude → rules applied → logged in shadow mode → 93.8% agreement, gate HOLD (1 wrongful decline)
6 · Dashboard             site/index.html
```

Then poke at it:

```bash
node bin/gtm.js ai audit ENQ-26226              # the full audit trail for one enquiry
node bin/gtm.js audience status                 # the staged run manifest
node bin/gtm.js report weekly --week 2026-08-31 # any week
node bin/gtm.js schedule                        # what runs when, and where
npm test
```

## What it looks like

Attribution, position-based model, 26 weeks. Cost includes the 2% referral commission so the referral channel is comparable with paid channels:

```
channel             enquiries  funded   principal     cost  £ / enquiry  £ / funded loan
Google Ads              378.6   101.1  £4,874,506  £81,405         £215             £806
LinkedIn Ads            101.4    20.3    £975,967  £50,313         £496           £2,475
Events                   50.7    16.3    £867,108  £22,635         £447           £1,387
Solicitor referral      191.3    73.0  £3,555,336  £71,107         £372             £974
Outbound email           34.3     5.6    £317,193  £11,624         £339           £2,070
Organic search          394.4    96.8  £4,836,607  £17,539          £44             £181
Direct                   29.4     5.9    £250,783       £0            —                —
```

And what Salesforce says about the same 326 funded loans, because people type "Web" into Lead Source:

```
Salesforce "Lead Source"  enquiries  funded
Web                             583     155
Solicitor Referral              194      75
(blank)                         153      34
Google Ads                      144      34
```

The gap between those two tables is the reason the attribution module exists.

## How it is put together

```
sources (SRA register, Law Society, events, LinkedIn)      ad platforms · invoices · website · email · referrals
             │                                                              │
             ▼                                                              ▼
   audience pipeline ──► audience_registry ──► sequencer         touches · ad_spend · identity_links
   discover→dedup→enrich→qualify→push(cap)   (Instantly/HeyReach shape)          │
             ▲                                                              ▼
   signals · status sync                                          attribution: resolve → stitch → models
                                                                            │
   Salesforce (read-only mirror) ── sf_leads · sf_opportunities · history · loans
                                                                            │
                                                                            ▼
   inbound enquiries ──► AI layer: model reads → rules route → human decides      weekly numbers: funnel by product × channel
                         shadow eval gate · audit_log (append-only)               markdown · Slack · site/index.html
```

- **One SQLite file** (`data/gtm.db`), schema in `sql/`, applied in order once. In production the same schema sits in a managed Postgres fed by a read-only Salesforce sync; nothing here writes into Salesforce.
- **One CLI** (`bin/gtm.js`) and **one task registry** (`scripts/orchestrator.js`) that the GitHub Actions workflows call. The same code runs locally and on the schedule.
- **Staged, checkpointed runs.** Every audience run has `runs/audience/<run_id>/manifest.json` with per-stage status, attempts and metrics. A failed run resumes from the failed stage.
- **Structured logs**, `[ISO] [gtm:module] message`, one file per day.

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What breaks and what you do about it: [docs/RUNBOOK.md](docs/RUNBOOK.md). Why it is built this way: [docs/decisions/](docs/decisions/).

## The AI layer, specifically

The division of labour is fixed and visible in the code:

- `scripts/ai-layer/extract.js`: the model **reads**. It fills a schema (product, jurisdiction, amounts, hearing date, solicitor) and writes a draft acknowledgement. It is told not to decide eligibility.
- `scripts/ai-layer/rules.js`: coded rules **decide**. Jurisdiction, product, solicitor instructed, amount bounds, the loan-to-value arithmetic, urgency, panel status. Every rule that fires is returned with its outcome.
- `human_decisions`: a **person** makes the call on every case, exactly as before the AI existed.
- `scripts/ai-layer/shadow-eval.js`: the **gate**. Route agreement, product agreement, arithmetic error, and the two errors that matter for a regulated lender: would it have declined a case a person took, would it have progressed a case a person declined. Below 90% agreement or any wrongful decline, it stays in shadow.
- `audit_log`: append-only, every actor named (`system:intake`, `model:<id>`, `rules:<version>`, `human:<name>`), with the prompt hash and model version on every model event.

`AI_MODE=shadow` logs and compares. `AI_MODE=assist` puts drafts in a review queue for a named person. There is no live mode; nothing reaches a customer without a human.

### What shadow mode found on the first live run

The 240 enquiries were read by Claude Opus 5 once (7.5 minutes, $4.21; the responses are cached in `data/fixtures/` so every later run is free and identical).

| | rules-v2 | rules-v3 |
|---|---|---|
| route agreement with the human decision | 76.7% | **93.8%** |
| max-loan arithmetic error | 0.3% | 0.3% |
| would have declined a case a person took | 1 | 1 |
| gate | HOLD | HOLD |

The 17-point gap was not the model's fault. When an email names no court, Claude correctly reports the jurisdiction as "not stated"; rule R01 then sent 46 cases to `needs_more_info`, while the people on the desk proceeded because they recognised the firm. The fix was a rule, not a prompt: `rules-v3` takes the jurisdiction from the instructed firm when the text is silent and the firm is known. Because decisions carry both `prompt_version` and `rules_version`, the re-evaluation ran on the cached readings at no cost.

The gate still holds, on purpose: one case the rules would have declined was one a person chose to ask about first. That is the kind of case a regulated lender wants a human to keep. The 15 remaining disagreements are all of the form "eligible on paper, the reviewer wanted valuation evidence first".

## What is real and what is mocked

| Piece | In this repo | In production |
|---|---|---|
| Database | SQLite via `node:sqlite` | managed Postgres |
| Salesforce | mirror tables filled by the seed | read-only Bulk API sync; changes inside Salesforce are specified for the engineering team |
| Audience sources | **Companies House API, live** when `COMPANIES_HOUSE_API_KEY` is set (real solicitor firms, SIC 69102, and their officers); the other sources are deterministic mocks | plus the SRA register, Law Society directory, event CSVs, LinkedIn via a data provider |
| Enrichment | mock provider A with fallback B; real people from the register are never given invented contact details and are never pushed without real ones | a waterfall of real providers, same two-call shape |
| Sequencer | mock with the Instantly / HeyReach shape | the real tool the marketer runs; the engine only pushes leads and reads statuses |
| Model | Claude via the Anthropic SDK when a key is present, else cached fixtures, else a labelled regex mock | Claude, with fixtures kept for regression |
| Slack | dry run unless a webhook is set | incoming webhooks |
| Schedule | GitHub Actions workflows in `.github/workflows/` | same |

## Repository map

```
bin/gtm.js                 CLI
lib/                       config, db + migrations, logger, rng, dates, manifest, claude, sequencer, ui
sql/                       001 core · 002 touches · 003 crm · 004 attribution · 005 ai layer · 006 reporting
scripts/seed.js            the synthetic world
scripts/seed-enquiries.js  free-text enquiries with ground truth and human decisions
scripts/audience/          pipeline (staged), signals, status sync
scripts/attribution/       resolve, stitch, models, report
scripts/reporting/         weekly funnel, Slack digest, dashboard
scripts/ai-layer/          extract, rules, triage, shadow-eval, audit
scripts/orchestrator.js    task registry + cron table
scripts/demo.js            the end-to-end run
.github/workflows/         audience-daily · attribution-nightly · weekly-numbers · ai-shadow · pages
docs/                      ARCHITECTURE · RUNBOOK · decisions/ADR-* · INTERVIEW-NOTES
test/                      rules, attribution models, determinism
site/index.html            the dashboard (generated, committed so GitHub Pages can serve it)
```

## Licence

MIT. Lodestar Legal Finance does not exist; any resemblance to a real firm or person in the generated data is coincidental.
