# ADR-003: The AI layer reads, rules decide, people judge

**Status:** accepted · 2026-10-08

## Context

Inbound enquiries are free text from solicitors and individuals. The lender is FCA-regulated: decisions must be explainable, logged and reversible, and nothing may reach a customer unreviewed.

## Decisions

1. **The model extracts, it does not decide.** Its output is a schema (product, jurisdiction, amounts, hearing, solicitor) and a draft acknowledgement. The system prompt says so and the schema has no "route" field.
2. **Routing and arithmetic are coded rules** (`rules.js`, versioned). Jurisdiction, product, solicitor instructed, amount bounds, loan-to-value cap, urgency, panel status. A rule returns its outcome and detail so the audit log is self-explanatory.
3. **A person decides every case**, exactly as before. The AI's route is a comparison column until the gate passes.
4. **Shadow mode is the default and the gate is explicit:** at least 90% route agreement with human decisions and zero cases the system would have declined that a person took. Only then does `AI_MODE=assist` put drafts in a review queue for a named person. There is no mode in which the system sends anything.
5. **Append-only audit log** with named actors (`system:*`, `model:<id>`, `rules:<version>`, `human:<name>`), prompt hash and model version on every model event.
6. **Provider is always labelled.** Live Anthropic calls are cached as fixtures; without a key the engine uses fixtures or a regex mock, and says so on every row. `--live` never falls back silently.

## Consequences

- Evaluation compares against what people actually decided, not against a hand-labelled truth, because that is what production will have.
- Prompt or rule changes are versioned; evaluations are comparable across versions.
- Cost is visible per decision (tokens and estimated USD) and per batch.
