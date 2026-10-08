# Architecture

## Principles

1. **One owner per number.** Every metric on the weekly report comes from one query in one file. If two people disagree about a number, they open the file, not a spreadsheet.
2. **Documents and tables are the source of truth, not a tool's memory.** The registry, not the sequencer, says who is in the audience. The audit log, not the model, says what was decided.
3. **Coded rules decide, models read, people judge.** The model never routes a case or computes a loan amount. Rules are pure functions with a version string.
4. **Prove it in shadow before it touches anyone.** Shadow mode is the default. Promotion is gated on measured agreement with human decisions.
5. **Fail loudly and resume.** Staged runs with manifests; a failed stage is retried from where it failed. Nothing is silently skipped; unattributed journeys are reported as unattributed.

## Data model

```
firms ──< contacts ──< audience_registry          audience_candidates (per run)   signals
                                                   
ad_spend                touches >── identity_links >── contacts
                                                   
sf_leads ──< sf_opportunities ──< sf_opportunity_history
                     │
                     └──< loans
                     └──< journeys ──< journey_touches
                     └──< attribution_credits (model × channel)

enquiries ──< ai_decisions          human_decisions        review_queue
          └── enquiry_labels (truth, generator and evaluator only)
audit_log (append-only)             shadow_evals
```

Views in `sql/006-reporting.sql` turn stage history into the weekly funnel: `v_opp_channel` picks the channel (last-touch attribution when a journey exists, a normalised Salesforce Lead Source otherwise, and says which), `v_stage_events_weekly` buckets stage entries by ISO week, `v_weekly_funnel` pivots them.

## Modules

### Audience (`scripts/audience/`)

Five stages, each idempotent and checkpointed:

| stage | input | output | failure behaviour |
|---|---|---|---|
| discover | source connectors | `audience_candidates` status `new`, `candidates.json` | a dead source fails the stage; resume re-runs only discovery |
| dedup | candidates + registry keys | status `duplicate` with reason | pure, cannot fail on data |
| enrich | candidates | email / LinkedIn / title; provider A then fallback B; `no_contact_data` when neither | provider outage fails the stage; rows already enriched are not re-billed on resume |
| qualify | enriched rows | coded fit score 0-10 against the ICP, threshold `AUDIENCE_MIN_FIT_SCORE` | pure |
| push | qualified rows + registry cursor | new registry rows, next N eligible rows pushed (`AUDIENCE_DAILY_PUSH_CAP`), `pushed_at` set | sequencer outage fails the stage; the cursor guarantees no double push |

The registry's `pushed_at` is the cursor. The sequencer is never asked "who have you got"; the registry already knows. `statusSync` pulls replies and meetings back. `signals` watches registry firms and scores signals with a fixed table (new partner 7, job ad 6, new office 6, ranking 5, news 3, +1 for panel firms, ±2 noise), alerting at 7.

### Attribution (`scripts/attribution/`)

1. **Resolve.** `identity_links` maps anonymous ids to contacts with a method and a confidence. Only links at or above 0.75 are used. Methods in the seed: `form_email` (1.0), `email_click_token` (0.95), `crm_match` (0.8).
2. **Stitch.** One journey per opportunity: the contact's touches in the lookback window (`ATTRIBUTION_LOOKBACK_DAYS`, default 90) up to the enquiry. No touches means `resolution = unresolved`, reported, never guessed.
3. **Models.** first touch, last touch, linear, position-based (40/20/40), time decay (7-day half-life). Impressions ride along but only earn credit when a journey has nothing else.
4. **Report.** Credited enquiries, funded loans and principal per channel per model, against spend for the window plus a 2% commission on referral-channel principal, next to the raw Salesforce Lead Source counts.

### Reporting (`scripts/reporting/`)

`weekly-funnel.js` builds the activity view (stage entries that week), the cohort view (enquiries from eight weeks ago and where they are now), the trailing 12 weeks and the channel table with spend, then writes markdown and JSON. `digest.js` renders the same JSON as Slack Block Kit. `build-dashboard.js` embeds the JSON in a single HTML page with inline SVG charts (no external scripts, works from disk and from GitHub Pages).

### AI layer (`scripts/ai-layer/`)

```
enquiry ─► extract.js (model reads; schema-constrained JSON; draft reply)
        ─► rules.js   (R01 jurisdiction · R02 product · R03 solicitor · R04 amount · R05 bounds · R06 LTV arithmetic · R07 urgency · R08 panel)
        ─► ai_decisions + audit_log
        ─► shadow: compare with human_decisions later      assist: review_queue for a named person
```

Prompt text is versioned (`PROMPT_VERSION`) and hashed into every decision and audit row. The model call uses structured outputs (`output_config.format` with a JSON schema) and `effort: low`; if structured outputs are rejected the call is retried with a plain JSON instruction and the response parsed. A `refusal` stop reason raises; nothing is written as a decision.

Provider resolution: `--live` always calls Anthropic and refreshes the fixture (`data/fixtures/triage/<prompt_version>/<enquiry_id>.json`); the default `auto` uses a cached fixture when one exists, else a live call when a key is set, else the mock reader. The provider is recorded on every decision and shown on every table. Decisions carry both `prompt_version` and `rules_version`, so a rule change re-evaluates the cached readings for free; a prompt change re-reads.

## Integrations and the production shape

| Concern | Here | Production |
|---|---|---|
| Salesforce | mirror tables | nightly read-only sync (Bulk API 2.0) of Lead, Opportunity, OpportunityHistory and the loan object into Postgres. Writes into Salesforce (new fields, flows, validation) are specified as tickets for the engineering team: `docs/specs/` would hold them |
| Ad platforms | `ad_spend` rows | Google Ads and LinkedIn reporting APIs by campaign and week; invoices for events and tooling via a finance export |
| Website and email | `touches` | GA4 / server-side event stream with a first-party anon id; sequencer click tokens; event check-in lists |
| Identity | `identity_links` | form submits, click tokens, CRM email match, referral partner introductions |
| Sources | Companies House live (`lib/sources/companies-house.js`: advanced search by SIC 69102 and name, then active officers; Basic auth; 600 requests per 5 minutes); other sources mocked | add the SRA register and Law Society directory, event CSVs, a LinkedIn data provider |
| Enrichment | mocks with the same two-call shape; real-register people are keyed by officer id and never given invented contact details | a provider waterfall |
| Sequencer | mock | the marketer's tool; the engine pushes leads and reads statuses only |
| Model | Anthropic SDK | same, with fixtures kept as a regression set and the shadow evaluation run every Friday |
| Delivery | Slack webhooks | same; the weekly report also commits to the repo for history and to GitHub Pages for the dashboard |
| Scheduling | GitHub Actions | same; a local daemon exists for anything that must sit next to a private resource |

## Security and compliance notes

- Secrets live in `.env` locally and in repository secrets on GitHub; nothing is committed.
- Logs contain ids and counts, not enquiry text. The audit log stores extracted fields and rule outcomes; the raw enquiry stays in `enquiries`.
- The audit log is append-only by convention and would be enforced with database permissions in production (insert-only role).
- Every model event carries the prompt hash and model id so a decision can be reproduced after a prompt change.
- No customer-facing message is sent by the system in any mode.
