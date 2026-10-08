# Runbook: what happens when it breaks

The engine is built so that most failures stop one stage, say so, and can be resumed. This page lists the failure modes worth planning for and what to do.

## Where to look first

```bash
node bin/gtm.js audience status          # per-stage status, attempts, error for the latest run
node bin/gtm.js status                   # row counts: is data flowing?
tail -n 50 logs/$(date -u +%F).log       # [ISO] [gtm:module] lines, grep by module
```

GitHub Actions keeps `runs/` and `logs/` as artifacts for 30 days on every scheduled run.

## Failure modes

| Symptom | Likely cause | What the system does | What you do |
|---|---|---|---|
| `audience-daily` fails at `discover` | a source is down or changed its format | stage marked `failed`, manifest saved, nothing pushed | fix the connector, `gtm audience resume --run-id <id>`; the other stages run once discovery succeeds |
| fails at `enrich` | provider outage or quota | stage `failed`; rows already enriched keep their data | resume; already-enriched rows are not re-billed. If the provider stays down, the fallback provider still runs |
| fails at `push` | sequencer API down | stage `failed`; `pushed_at` untouched, so no lead is pushed twice | resume when it is back. The daily cap still applies to the retry |
| the same person pushed twice | a new source spelled the email differently | dedup keys are lower-cased emails, else LinkedIn URLs | add the alias to `identity_links`-style normalisation in `profileKey`; suppress the duplicate in the registry |
| reply rate drops to zero | status sync broken, not the campaign | `statusSync` logs `checked / replied` | check the sequencer token first; the registry keeps counting from the last good sync |
| unattributed share jumps | identity links stopped arriving (form change, click tokens dropped) | reported in the attribution output and the dashboard as "could not be tied to any touch" | check `identity_links` by method and date; the weekly report falls back to Salesforce Lead Source and says so |
| cost per funded loan looks wrong for one channel | spend import gap or double import | spend is per week per campaign with a source column | reload the week; `ad_spend` rows upsert on `spend_id` |
| model returns `refusal` or an API error | safety classifier or outage | the call raises; no decision is written; the run fails loudly | re-run later; `--fixtures` reruns against cached responses; the mock is never used silently when `--live` was asked for |
| shadow gate says HOLD | the reader or a rule disagrees with people more than 10% of the time, or any wrongful decline | nothing changes for customers; drafts are not queued | read the flagged list (`gtm ai shadow-eval`), then the audit trail of one case (`gtm ai audit <id>`). Fix the prompt or the rule, bump `PROMPT_VERSION` or `RULES_VERSION`, re-run on the same enquiries |
| a prompt change changed decisions | expected | every decision carries `prompt_version` and `prompt_hash` | compare evals across versions in `shadow_evals` |
| Slack digest did not arrive | webhook unset or revoked | dry-run payload saved to `reports/weekly/<week>.slack.json` | set `SLACK_WEBHOOK_URL`, re-run `gtm report digest` |
| numbers differ between the markdown, Slack and the dashboard | they cannot; all three read the same JSON | | if they do, the dashboard was built before the report; re-run `weekly-numbers` |

## Re-running safely

- `gtm seed` resets the database (demo). In production there is no seed; the Salesforce sync is the source.
- Attribution is fully recomputed on every run (`DELETE` then rebuild). It is idempotent.
- Triage skips enquiries that already have a decision for the current `PROMPT_VERSION`. Bump the version to re-read everything.
- Audience stages are idempotent per run id; `--force` re-runs a completed stage.

## Alerting (production)

- Workflow failure → GitHub notification to the owner, plus a Slack message from the `failure()` step.
- Data freshness: the weekly job checks that the latest Salesforce sync is under 36 hours old and refuses to publish otherwise.
- Attribution: alert when the unattributed share rises more than 5 points week on week.
- AI layer: alert when route agreement drops below the gate on the Friday evaluation, or when any wrongful decline appears.
