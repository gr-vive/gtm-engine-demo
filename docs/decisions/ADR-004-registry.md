# ADR-004: The registry is the source of truth for the outbound audience

**Status:** accepted · 2026-10-08

## Context

The marketer owns the sequencing tool and the copy. The engineer owns the lists: current, enriched, deliverable, with no one contacted twice and a daily volume cap the sending domains can sustain.

## Decisions

1. **`audience_registry` keyed by a normalised profile key** (lower-cased email, else LinkedIn URL). Candidates from every source are deduplicated against it before enrichment is paid for, and again after enrichment reveals a new key.
2. **`pushed_at` is the cursor.** The daily push takes the next N eligible rows (never pushed, not suppressed, fit above threshold) ordered by fit then by age. The sequencer is told who to contact; it is never asked who it has.
3. **Statuses flow back into the registry** (`replied_at`, `meeting_at`) on a schedule, so the reply rate is the registry's number, not the tool's.
4. **Suppression lives in the registry** (opt-outs, bounces, existing customers) and wins over everything.
5. **Qualification is coded**, a 0-10 fit score with the reasons recorded. The score is not a model output; it is cheap, deterministic and arguable in a meeting.

## Consequences

- Swapping the sequencer is a new adapter with two methods (`pushLeads`, `fetchStatuses`).
- The daily cap is a configuration value, not a habit.
- Staged runs mean a provider outage costs one stage, not a day.
