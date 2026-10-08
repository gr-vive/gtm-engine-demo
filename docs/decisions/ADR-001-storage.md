# ADR-001: SQLite in the repo, Postgres in production

**Status:** accepted · 2026-10-08

## Context

The demo must run on a laptop with `npm install` and nothing else, and the schema must be the same one production uses.

## Decision

Use Node's built-in `node:sqlite` (no native build) with migrations in `sql/NNN-name.sql`, applied in order once and tracked in `schema_migrations`. The SQL stays within what Postgres also accepts; the only SQLite-specific pieces are the date helpers in the reporting views, isolated in `sql/006-reporting.sql`.

## Consequences

- Zero-install demo; CI runs the same code.
- Production swaps the connection for Postgres and the seed for the Salesforce sync. Views are rewritten once for Postgres date functions.
- Concurrency is not a concern for the demo; in production the scheduled jobs run sequentially per resource (GitHub Actions concurrency groups).
