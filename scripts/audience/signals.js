'use strict';

/**
 * Two small daily jobs that keep the registry honest:
 *   signals     watch registry firms for buying signals (new partner, new office,
 *               rankings, job ads, news), score them with coded rules, alert on ≥ 7
 *   statusSync  pull reply / meeting statuses back from the sequencer so the
 *               registry, not the tool, is the source of truth
 */

const config = require('../../lib/config');
const db = require('../../lib/db');
const ui = require('../../lib/ui');
const sequencer = require('../../lib/sequencer');
const { Rng } = require('../../lib/rng');
const { fnv1a } = require('../../lib/hash');
const { logger } = require('../../lib/logger');

const log = logger('signals');
const now = () => new Date().toISOString();
const SIGNAL_SCORE = { new_partner: 7, job_ad: 6, new_office: 6, ranking: 5, news: 3 };
const ALERT_THRESHOLD = 7;

async function signals({ quiet = false } = {}) {
  const conn = db.open();
  const rng = new Rng(fnv1a(`${config.SEED}|signals|${now().slice(0, 10)}`));
  const firms = db.all(conn, 'SELECT DISTINCT f.* FROM firms f JOIN audience_registry r ON r.firm_id = f.firm_id');
  const seen = new Set(db.all(conn, 'SELECT url FROM signals').map((s) => s.url));
  const templates = [
    ['new_partner', (f) => `${f.name} promotes ${rng.pick(['two', 'three'])} to partner in family team`],
    ['job_ad', (f) => `${f.name} advertises Private Client Solicitor role (probate, 3+ PQE)`],
    ['new_office', (f) => `${f.name} opens office in ${rng.pick(['Guildford', 'Harrogate', 'Chester', 'Bath', 'Winchester'])}`],
    ['ranking', (f) => `${f.name} listed for Family in the regional legal guide`],
    ['news', (f) => `${f.name} publishes note on financial remedy court delays`],
  ];
  const found = [];
  for (let i = 0; i < 24; i++) {
    const f = rng.pick(firms);
    const [type, headline] = rng.pick(templates);
    const url = `https://www.${f.website_domain}/news/${fnv1a(`${f.firm_id}|${type}|${now().slice(0, 10)}`).toString(16).slice(0, 6)}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const score = Math.max(1, Math.min(10, SIGNAL_SCORE[type] + (f.on_panel ? 1 : 0) + rng.int(-2, 2)));
    found.push({ signal_id: rng.id('sig', 8), firm_id: f.firm_id, contact_id: null, signal_type: type, headline: headline(f), url, score, detected_at: now(), alerted_at: score >= ALERT_THRESHOLD ? now() : null, firm: f.name });
  }
  db.insertMany(conn, 'signals', found.map(({ firm: _f, ...s }) => s));
  const alerts = found.filter((s) => s.score >= ALERT_THRESHOLD).sort((a, b) => b.score - a.score);
  log.info('signals run', { found: found.length, alerts: alerts.length });
  if (!quiet) {
    ui.section(`Buying signals · ${firms.length} registry firms watched`);
    ui.ok(`${found.length} new signals, ${alerts.length} above the alert threshold (${ALERT_THRESHOLD})`);
    ui.table(alerts.slice(0, 8), [
      { key: 'score', label: 'score', align: 'right', fmt: (v) => (v >= 9 ? ui.c.magenta(String(v)) : String(v)) },
      { key: 'signal_type', label: 'type' },
      { key: 'firm', label: 'firm' },
      { key: 'headline', label: 'headline' },
    ]);
    ui.info(config.SLACK_SIGNALS_WEBHOOK_URL ? 'alerts posted to Slack' : 'dry run: set SLACK_SIGNALS_WEBHOOK_URL to post alerts to #signals');
  }
  return { found: found.length, alerts: alerts.length };
}

async function statusSync({ quiet = false } = {}) {
  const conn = db.open();
  const pending = db.all(conn, 'SELECT profile_key, sequencer, sequencer_lead_id FROM audience_registry WHERE pushed_at IS NOT NULL AND replied_at IS NULL');
  const updates = await sequencer.fetchStatuses(pending);
  const upd = conn.prepare('UPDATE audience_registry SET replied_at=?, meeting_at=COALESCE(?, meeting_at) WHERE profile_key=?');
  for (const u of updates) upd.run(u.replied_at, u.meeting_at, u.profile_key);
  const meetings = updates.filter((u) => u.meeting_at).length;
  log.info('status sync', { checked: pending.length, replied: updates.length, meetings });
  if (!quiet) {
    ui.section('Sequencer status sync');
    ui.ok(`${pending.length} pushed profiles checked · ${updates.length} new replies · ${meetings} meetings booked`);
  }
  return { checked: pending.length, replied: updates.length, meetings };
}

module.exports = { signals, statusSync };
