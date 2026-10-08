# ADR-005: Salesforce is read, never written

**Status:** accepted · 2026-10-08

## Context

Salesforce is the core system and stays that way. Development inside the platform belongs to the engineering team; the growth engineer specifies that work.

## Decisions

1. **A read-only mirror.** `sf_leads`, `sf_opportunities`, `sf_opportunity_history` and `loans` are filled by a sync, never by the engine. The mirror keeps Salesforce ids so every number is traceable back to a record.
2. **Attribution, reporting and the AI layer run outside the platform** on the mirror and on data Salesforce does not have (touches, spend, enquiry text).
3. **Changes inside Salesforce are specs.** When a result should live in Salesforce (an attributed-channel field, a triage priority flag, a referral partner object), the engine's output is the evidence and the spec; the engineering team builds the field or flow.

## Consequences

- No risk of the engine corrupting the system of record.
- A clear seam for the "which marketing produced which lending" conversation: the engine shows the comparison, the business decides what to write back.
