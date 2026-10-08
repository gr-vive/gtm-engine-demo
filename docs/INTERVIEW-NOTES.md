# Interview notes: what to show for each question

The brief asks for five things. Each maps to one part of this repo and to past work that can be described without client material.

## 1. Systems you've built

**Show:** `npm run demo`, then the architecture section of the README. Walk the six banners: seed, audience, attribution, numbers, AI layer, dashboard.

**Say:** the shape is the one I use for real: one CLI, one task registry, staged runs with manifests, structured logs, markdown reports that are also Slack messages and a web page. Nothing here is a one-off script.

**Past work, safe to describe:** a content and distribution engine for a B2B SaaS client run by one person plus scheduled agents (eight GitHub Actions jobs, a Google Sheet as the editing surface, Supabase as the store, a Next.js dashboard). Six months from an unindexed site to 524 queries in Google's top 10.

## 2. Your most valuable automation

**Show:** `node bin/gtm.js audience run` then `node bin/gtm.js audience status`. Then open `runs/audience/<id>/manifest.json`.

**Say, in the order they ask:** before, a person built lists by hand and the sequencer was the only record of who had been contacted. What I built: discover, dedup, enrich, qualify, push, with the registry as the source of truth and a daily cap. How it works: five stages, each idempotent, checkpointed, resumable. Reliability: a provider outage fails one stage and the run resumes from it; the cursor makes double-pushing impossible; replies flow back so the reply rate is ours, not the tool's. Saved: the prospecting system this is modelled on ran every weekday for over three months without a person touching it, 118 scheduled runs, each one logging tokens, calls, seconds and what it skipped.

## 3. Examples of your work

**Show:** this repository, the dashboard on GitHub Pages, `npm test`.

**Also available publicly:** a LinkedIn influencer finder that reversed the usual approach (mine the real reactions of ICP contacts, rank authors by how many decision-makers sit in their audience): 115,824 actions by 2,053 decision-makers, 32,274 authors ranked, a top 20 that drove a six-figure creator budget.

## 4. Data, attribution and commercial reporting

**Show:** `node bin/gtm.js attribution run`. Point at the two tables: five models side by side, then what Salesforce Lead Source says about the same funded loans. Then `node bin/gtm.js report weekly` and the cohort view.

**Say:** the customer journey from first click to funded loan is: touches with an anonymous id → identity links with a method and confidence → one journey per opportunity in a 90-day lookback → credit per channel under five models → joined to the funded loan and its principal → divided by spend plus referral commission. The CRM field is kept as a comparison column, never overwritten. Unattributed is reported as a share, not guessed. Weekly numbers come from one query and feed the markdown, the Slack digest and the dashboard, so the three cannot disagree.

**On Salesforce:** read-only mirror, specs for anything that should live inside the platform (ADR-005).

## 5. AI and automation

**Show:** `node bin/gtm.js ai triage`, then `node bin/gtm.js ai shadow-eval`, then `node bin/gtm.js ai audit ENQ-26226`.

**Say:** the division of labour is in the code. The model reads and drafts; coded rules route and do the arithmetic (jurisdiction, product, solicitor, bounds, loan-to-value, urgency, panel); a person decides every case. Shadow mode logs and compares; the gate is 90% route agreement and zero wrongful declines; assist mode puts drafts in a review queue for a named person; there is no mode that sends. The audit log is append-only with named actors, prompt hash and model version on every row.

**Measured effectiveness, past work:** a Reddit relay that scanned threads, classified them, drafted replies and sent them to a human to post: 683 threads → 90 drafts → 25 published, a 28% acceptance rate that was tracked per draft, at about $0.59 a day. The acceptance rate was the metric that decided whether to keep tuning the classifier or the drafting.

## Things to be ready for

- *"What happens when the model is down?"* The call raises, no decision is written, the run fails loudly, the Friday evaluation shows the gap. `--fixtures` replays cached responses. Nothing falls back silently when a live run was asked for.
- *"Why not let the model route?"* Because a rule can be read by compliance, versioned, and tested in `test/rules.test.js`. The model's job is the part rules cannot do: reading prose.
- *"Why five attribution models?"* Because the marketer and the CFO ask different questions; showing them side by side ends the argument about which one is right.
- *"What would you build in month one?"* The Salesforce mirror sync and the weekly numbers. Everything else needs those two.
