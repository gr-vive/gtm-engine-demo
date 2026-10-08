'use strict';

/**
 * Audience pipeline: keeps the professional audience current and deliverable.
 *
 *   discover  pull candidates from the sources (SRA register, Law Society,
 *             event attendee lists, LinkedIn)                 → audience_candidates
 *   dedup     drop anyone already in the registry             (profile_key)
 *   enrich    fill email / LinkedIn / title, provider A then B
 *   qualify   coded fit score against the ICP; threshold      (AUDIENCE_MIN_FIT_SCORE)
 *   push      add to registry, hand the next N to the sequencer (AUDIENCE_DAILY_PUSH_CAP)
 *
 * Each stage is checkpointed in runs/audience/<run_id>/manifest.json.
 * A failed run resumes from the failed stage: `gtm audience resume --run-id <id>`.
 * Source connectors are mocked (deterministic per day); see docs/ARCHITECTURE.md.
 */

const config = require('../../lib/config');
const db = require('../../lib/db');
const ui = require('../../lib/ui');
const manifest = require('../../lib/manifest');
const sequencer = require('../../lib/sequencer');
const { Rng } = require('../../lib/rng');
const { fnv1a } = require('../../lib/hash');
const { logger } = require('../../lib/logger');

const log = logger('audience');
const STAGES = ['discover', 'dedup', 'enrich', 'qualify', 'push'];
const KIND = 'audience';
const TARGET_ROLES = new Set(['partner', 'head_of_department', 'solicitor']);

const now = () => new Date().toISOString();
const norm = (s) => String(s || '').trim().toLowerCase();
// email, else LinkedIn, else the source's own id (a real person we have not enriched yet)
const profileKey = (c) => (c.email ? norm(c.email) : c.linkedin_url ? norm(c.linkedin_url) : c.external_id ? `ext:${c.external_id}` : null);

// ---- discover -------------------------------------------------------------

/** The live source: real solicitor firms and their officers from the Companies House register. */
async function discoverCompaniesHouse(m, rng) {
  const ch = require('../../lib/sources/companies-house');
  if (!ch.enabled()) return [];
  const firms = await ch.discoverLawFirms({ queries: ['family law', 'probate'], companiesPerQuery: 8, officersPerCompany: 3 });
  const rows = [];
  for (const { company, officers } of firms) {
    for (const o of officers) {
      rows.push({
        candidate_id: rng.id('cnd', 10),
        run_id: m.run_id,
        source: 'companies_house',
        firm_name: company.name,
        website_domain: null, // the register has no website; enrichment would have to find it
        person_name: `${o.first} ${o.last}`.trim(),
        email: null,
        linkedin_url: null,
        external_id: o.officer_id || `${company.company_number}:${o.raw_name}`,
        raw_json: JSON.stringify({
          live: true,
          title: o.role === 'director' ? 'Director' : /llp/.test(o.role) ? 'LLP Member' : o.role,
          firm_id: null,
          company_number: company.company_number,
          company_url: company.url,
          city: company.city,
          region: company.region,
          practice_areas: company.practice_areas,
          jurisdiction: company.jurisdiction,
          size_band: null,
          on_panel: 0,
          incorporated: company.incorporated,
        }),
        status: 'new',
        reason: null,
        fit_score: null,
        updated_at: now(),
      });
    }
  }
  return rows;
}

async function discover(m, conn) {
  const daySeed = fnv1a(`${config.SEED}|${m.run_id.slice(0, 8)}`); // same day → same candidates; new day → new ones
  const rng = new Rng(daySeed);
  const live = await discoverCompaniesHouse(m, rng);
  const firms = db.all(conn, "SELECT * FROM firms WHERE source <> 'inbound_form'");
  const contacts = db.all(conn, 'SELECT c.*, f.name AS firm_name, f.website_domain FROM contacts c JOIN firms f ON f.firm_id=c.firm_id');
  const FIRST = ['Priya', 'James', 'Amelia', 'Tom', 'Rachel', 'Daniel', 'Hannah', 'Oliver', 'Sophie', 'Ben', 'Fatima', 'Kwame', 'Elena', 'Marcus', 'Niamh', 'Arjun'];
  const LAST = ['Hartley', 'Finch', 'Pemberton', 'Ashcroft', 'Marlow', 'Rowe', 'Okafor', 'Nandakumar', 'Osei', 'Petrova', 'Rahman', 'Walsh', 'Bianchi', 'Chaudhry', 'Mensah', 'Novak'];
  const TITLES = ['Partner', 'Head of Family', 'Head of Private Client', 'Senior Associate', 'Solicitor', 'Paralegal', 'Practice Manager'];

  const sources = { sra_register: 18, law_society: 10, events: 8, linkedin: 9 };
  const rows = [...live];
  for (const [source, n] of Object.entries(sources)) {
    for (let i = 0; i < n; i++) {
      const existing = rng.chance(0.4) ? rng.pick(contacts) : null; // someone we already know (dedup must catch)
      const firm = existing ? firms.find((f) => f.firm_id === existing.firm_id) || rng.pick(firms) : rng.pick(firms);
      const first = existing ? existing.first_name : rng.pick(FIRST);
      const last = existing ? existing.last_name : rng.pick(LAST);
      const title = existing ? existing.title : rng.pick(TITLES);
      const email = existing ? existing.email : source === 'events' || rng.chance(0.35) ? `${first.toLowerCase()}.${last.toLowerCase()}@${firm.website_domain}` : null;
      const linkedin = existing ? existing.linkedin_url : source === 'linkedin' || rng.chance(0.3) ? `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${rng.int(100, 999)}` : null;
      rows.push({
        candidate_id: rng.id('cnd', 10),
        run_id: m.run_id,
        source,
        firm_name: firm.name,
        website_domain: firm.website_domain,
        person_name: `${first} ${last}`,
        email,
        linkedin_url: linkedin,
        external_id: null,
        raw_json: JSON.stringify({ title, firm_id: firm.firm_id, city: firm.city, practice_areas: firm.practice_areas, jurisdiction: firm.jurisdiction, size_band: firm.size_band, on_panel: firm.on_panel }),
        status: 'new',
        reason: null,
        fit_score: null,
        updated_at: now(),
      });
    }
  }
  db.insertMany(conn, 'audience_candidates', rows);
  manifest.artifact(m, 'candidates.json', rows);
  const bySource = rows.reduce((a, r) => ((a[r.source] = (a[r.source] || 0) + 1), a), {});
  return { discovered: rows.length, by_source: bySource, live_source: live.length ? 'companies_house' : null };
}

// ---- dedup ----------------------------------------------------------------

function dedup(m, conn) {
  const rows = db.all(conn, "SELECT * FROM audience_candidates WHERE run_id = ? AND status = 'new'", m.run_id);
  const inRegistry = new Set(db.all(conn, 'SELECT profile_key FROM audience_registry').map((r) => r.profile_key));
  const seen = new Set();
  const upd = conn.prepare('UPDATE audience_candidates SET status=?, reason=?, updated_at=? WHERE candidate_id=?');
  let dupes = 0;
  for (const c of rows) {
    const key = profileKey(c);
    if (key && (inRegistry.has(key) || seen.has(key))) {
      upd.run('duplicate', inRegistry.has(key) ? 'already_in_registry' : 'duplicate_in_run', now(), c.candidate_id);
      dupes++;
    } else if (key) seen.add(key);
  }
  return { duplicates: dupes, carried_forward: rows.length - dupes };
}

// ---- enrich ---------------------------------------------------------------

function enrich(m, conn) {
  const rows = db.all(conn, "SELECT * FROM audience_candidates WHERE run_id = ? AND status = 'new'", m.run_id);
  const inRegistry = new Set(db.all(conn, 'SELECT profile_key FROM audience_registry').map((r) => r.profile_key));
  const upd = conn.prepare('UPDATE audience_candidates SET status=?, reason=?, email=?, linkedin_url=?, raw_json=?, updated_at=? WHERE candidate_id=?');
  let a = 0;
  let b = 0;
  let none = 0;
  let lateDupes = 0;
  for (const c of rows) {
    const rng = new Rng(fnv1a(`${c.candidate_id}|enrich`));
    const raw = JSON.parse(c.raw_json);
    const [first, last] = c.person_name.toLowerCase().split(' ');
    let provider = null;
    if (raw.live) {
      // A real person from a public register: the mock providers must not invent contact
      // details. They stay keyed by the register id until a real enrichment provider runs.
      raw.role_type = /llp|member|partner/i.test(raw.title) ? 'partner' : /director/i.test(raw.title) ? 'partner' : 'finance';
      raw.practice_area = raw.practice_areas === 'mixed' ? 'mixed' : raw.practice_areas.split(',')[0];
      upd.run('enriched', 'real_source_contact_data_pending', null, null, JSON.stringify(raw), now(), c.candidate_id);
      continue;
    }
    if (rng.chance(0.72)) provider = 'provider_a';
    else if (rng.chance(0.6)) provider = 'provider_b';
    if (provider) {
      if (!c.email && rng.chance(0.85)) c.email = `${first}.${last}@${c.website_domain}`;
      if (!c.linkedin_url && rng.chance(0.7)) c.linkedin_url = `https://www.linkedin.com/in/${first}-${last}-${rng.int(100, 999)}`;
      raw.enriched_by = provider;
      raw.role_type = /partner/i.test(raw.title) ? 'partner' : /head of/i.test(raw.title) ? 'head_of_department' : /solicitor|associate/i.test(raw.title) ? 'solicitor' : /paralegal/i.test(raw.title) ? 'paralegal' : 'finance';
      raw.practice_area = /probate|private client/i.test(raw.title) ? 'probate' : /family/i.test(raw.title) ? 'family' : raw.practice_areas.includes('family') ? 'family' : 'probate';
      provider === 'provider_a' ? a++ : b++;
    }
    const key = profileKey(c);
    if (!key) {
      upd.run('disqualified', 'no_contact_data', c.email, c.linkedin_url, JSON.stringify(raw), now(), c.candidate_id);
      none++;
    } else if (inRegistry.has(key)) {
      upd.run('duplicate', 'already_in_registry_after_enrichment', c.email, c.linkedin_url, JSON.stringify(raw), now(), c.candidate_id);
      lateDupes++;
    } else upd.run('enriched', null, c.email, c.linkedin_url, JSON.stringify(raw), now(), c.candidate_id);
  }
  return { provider_a: a, provider_b: b, no_contact_data: none, late_duplicates: lateDupes };
}

// ---- qualify --------------------------------------------------------------

function scoreCandidate(raw) {
  const reasons = [];
  let score = 0;
  if (raw.jurisdiction !== 'England and Wales') return { score: 0, reasons: ['outside_jurisdiction'], disqualify: 'outside_jurisdiction' };
  if (!TARGET_ROLES.has(raw.role_type)) return { score: 0, reasons: ['role_not_target'], disqualify: 'role_not_target' };
  score += raw.role_type === 'partner' ? 4 : raw.role_type === 'head_of_department' ? 4 : 2;
  reasons.push(`role:${raw.role_type}`);
  if (['family', 'probate'].includes(raw.practice_area)) {
    score += 3;
    reasons.push(`practice:${raw.practice_area}`);
  } else if (raw.practice_area === 'mixed') {
    score += 2;
    reasons.push('practice:law_firm_unspecified');
  }
  if (['6-20', '21-50', '51-200'].includes(raw.size_band)) {
    score += 1;
    reasons.push(`size:${raw.size_band}`);
  }
  if (raw.on_panel) {
    score += 1;
    reasons.push('panel_firm');
  }
  if (raw.enriched_by === 'provider_a') {
    score += 1;
    reasons.push('verified_email');
  }
  return { score: Math.min(10, score), reasons, disqualify: null };
}

function qualify(m, conn) {
  const rows = db.all(conn, "SELECT * FROM audience_candidates WHERE run_id = ? AND status = 'enriched'", m.run_id);
  const upd = conn.prepare('UPDATE audience_candidates SET status=?, reason=?, fit_score=?, updated_at=? WHERE candidate_id=?');
  let q = 0;
  let d = 0;
  const qualified = [];
  for (const c of rows) {
    const raw = JSON.parse(c.raw_json);
    const s = scoreCandidate(raw);
    if (s.disqualify) {
      upd.run('disqualified', s.disqualify, s.score, now(), c.candidate_id);
      d++;
    } else if (s.score < config.AUDIENCE_MIN_FIT_SCORE) {
      upd.run('disqualified', `fit_${s.score}_below_${config.AUDIENCE_MIN_FIT_SCORE}`, s.score, now(), c.candidate_id);
      d++;
    } else {
      upd.run('qualified', s.reasons.join(','), s.score, now(), c.candidate_id);
      qualified.push({ ...c, fit_score: s.score, reasons: s.reasons });
      q++;
    }
  }
  manifest.artifact(m, 'qualified.json', qualified);
  return { qualified: q, disqualified: d, min_fit: config.AUDIENCE_MIN_FIT_SCORE };
}

// ---- push -----------------------------------------------------------------

async function push(m, conn) {
  const rows = db.all(conn, "SELECT * FROM audience_candidates WHERE run_id = ? AND status = 'qualified'", m.run_id);
  const rng = new Rng(fnv1a(`${m.run_id}|push`));
  // 1. make sure each qualified person exists as a contact (and firm) and in the registry
  const findFirm = conn.prepare('SELECT firm_id FROM firms WHERE firm_id = ?');
  const insFirm = conn.prepare('INSERT OR IGNORE INTO firms (firm_id, name, sra_number, city, region, jurisdiction, practice_areas, size_band, website_domain, on_panel, source, first_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const findContact = conn.prepare('SELECT contact_id FROM contacts WHERE (LOWER(email) = ? AND email IS NOT NULL) OR (LOWER(linkedin_url) = ? AND linkedin_url IS NOT NULL)');
  const insContact = conn.prepare('INSERT INTO contacts (contact_id, firm_id, first_name, last_name, title, role_type, practice_area, email, linkedin_url, source, first_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const insReg = conn.prepare('INSERT OR IGNORE INTO audience_registry (profile_key, contact_id, firm_id, segment, fit_score, qualified_at, dedup_run_at) VALUES (?,?,?,?,?,?,?)');
  let added = 0;
  let awaiting = 0;
  for (const c of rows) {
    const raw = JSON.parse(c.raw_json);
    if (raw.live && raw.company_number && !raw.firm_id) {
      // a real firm from the register becomes a firm row, keyed by its company number
      raw.firm_id = `ch_${raw.company_number}`;
      insFirm.run(raw.firm_id, c.firm_name, null, raw.city, raw.region, raw.jurisdiction, raw.practice_areas, raw.size_band, null, 0, 'companies_house', now());
    }
    if (!findFirm.get(raw.firm_id)) continue;
    const key = profileKey(c);
    if (!key) continue;
    if (!c.email && !c.linkedin_url) awaiting++;
    let contact = findContact.get(norm(c.email), norm(c.linkedin_url));
    if (!contact) {
      const [first, last] = c.person_name.split(' ');
      const id = rng.id('ctc');
      insContact.run(id, raw.firm_id, first, last, raw.title, raw.role_type, raw.practice_area, c.email, c.linkedin_url, c.source, now());
      contact = { contact_id: id };
    }
    const segment = raw.on_panel ? 'panel_expansion' : raw.practice_area === 'family' ? 'family_partners' : raw.practice_area === 'probate' ? 'probate_partners' : 'mixed';
    insReg.run(key, contact.contact_id, raw.firm_id, segment, c.fit_score, now(), now());
    added++;
  }
  // 2. the cursor: next N eligible rows never pushed, best fit first.
  //    Nobody without an email or LinkedIn URL is ever handed to a sequencer.
  const cap = config.AUDIENCE_DAILY_PUSH_CAP;
  const batch = db.all(
    conn,
    `SELECT r.profile_key, r.segment, r.fit_score, c.first_name, c.last_name, f.name AS firm
     FROM audience_registry r LEFT JOIN contacts c ON c.contact_id=r.contact_id LEFT JOIN firms f ON f.firm_id=r.firm_id
     WHERE r.pushed_at IS NULL AND r.suppressed = 0 AND r.fit_score >= ?
       AND (c.email IS NOT NULL OR c.linkedin_url IS NOT NULL)
     ORDER BY r.fit_score DESC, r.qualified_at ASC LIMIT ?`,
    config.AUDIENCE_MIN_FIT_SCORE,
    cap,
  );
  const results = await sequencer.pushLeads(batch);
  const upd = conn.prepare('UPDATE audience_registry SET pushed_at=?, sequencer=?, sequencer_lead_id=? WHERE profile_key=?');
  for (const r of results) upd.run(now(), r.sequencer, r.sequencer_lead_id, r.profile_key);
  // candidate status: 'pushed' only if this run's push actually took them; otherwise 'registered'
  const pushedKeys = new Set(results.map((r) => r.profile_key));
  const updCand = conn.prepare('UPDATE audience_candidates SET status=?, reason=?, updated_at=? WHERE candidate_id=?');
  for (const c of rows) {
    const key = profileKey(c);
    if (key && pushedKeys.has(key)) updCand.run('pushed', c.reason, now(), c.candidate_id);
    else updCand.run('registered', !c.email && !c.linkedin_url ? 'awaiting_contact_data' : 'waiting_for_daily_cap', now(), c.candidate_id);
  }
  const remaining = db.scalar(conn, `SELECT COUNT(*) FROM audience_registry r JOIN contacts c ON c.contact_id = r.contact_id WHERE r.pushed_at IS NULL AND r.suppressed=0 AND r.fit_score >= ? AND (c.email IS NOT NULL OR c.linkedin_url IS NOT NULL)`, config.AUDIENCE_MIN_FIT_SCORE);
  manifest.artifact(m, 'pushed.json', results);
  const bySeq = results.reduce((a, r) => ((a[r.sequencer] = (a[r.sequencer] || 0) + 1), a), {});
  return { added_to_registry: added, awaiting_contact_data: awaiting, pushed: results.length, daily_cap: cap, remaining_eligible: remaining, by_sequencer: bySeq };
}

// ---- runner ---------------------------------------------------------------

const STAGE_FN = { discover, dedup, enrich, qualify, push };

async function runPipeline({ runId, force = false, only = null, quiet = false } = {}) {
  const conn = db.open();
  const m = runId ? manifest.load(KIND, runId) : manifest.create(KIND, STAGES);
  if (!quiet) ui.section(`Audience pipeline · run ${m.run_id}${runId ? ' (resumed)' : ''}`);
  const stages = only ? [only] : STAGES;
  for (const stage of stages) {
    try {
      const r = await manifest.runStage(m, stage, (mm) => STAGE_FN[stage](mm, conn), { force });
      if (quiet) continue;
      const met = r.metrics;
      const summary = {
        discover: () => `${met.discovered} candidates from ${Object.entries(met.by_source).map(([k, v]) => `${k}×${v}${k === met.live_source ? ' (live)' : ''}`).join(', ')}${met.live_source ? '' : ' · all sources mocked (set COMPANIES_HOUSE_API_KEY for a live one)'}`,
        dedup: () => `${met.duplicates} already known, ${met.carried_forward} carried forward`,
        enrich: () => `provider A ×${met.provider_a}, fallback B ×${met.provider_b}, no contact data ×${met.no_contact_data}${met.late_duplicates ? `, ${met.late_duplicates} turned out to be known` : ''}`,
        qualify: () => `${met.qualified} qualified (fit ≥ ${met.min_fit}), ${met.disqualified} disqualified`,
        push: () => `${met.added_to_registry} added to registry${met.awaiting_contact_data ? ` (${met.awaiting_contact_data} real people awaiting contact data, never pushed without it)` : ''} · ${met.pushed} handed to sequencer (${Object.entries(met.by_sequencer).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}) · cap ${met.daily_cap} · ${met.remaining_eligible} still waiting`,
      }[stage]();
      r.skipped ? ui.info(`${stage}: skipped, already completed`) : ui.ok(`${stage}: ${summary}`);
    } catch (err) {
      if (!quiet) ui.fail(`${stage} failed: ${err.message} → fix and run: gtm audience resume --run-id ${m.run_id}`);
      throw err;
    }
  }
  log.info('pipeline finished', { run_id: m.run_id, status: m.status });
  return m;
}

function status(runId) {
  const m = runId ? manifest.load(KIND, runId) : manifest.latest(KIND);
  if (!m) {
    ui.warn('no audience runs yet');
    return null;
  }
  ui.section(`Run ${m.run_id} · ${m.status}`);
  ui.table(
    m.stage_order.map((s) => ({ stage: s, ...m.stages[s] })),
    [
      { key: 'stage', label: 'stage' },
      { key: 'status', label: 'status', fmt: (v) => (v === 'completed' ? ui.c.green(v) : v === 'failed' ? ui.c.red(v) : ui.c.dim(v)) },
      { key: 'attempts', label: 'attempts', align: 'right' },
      { key: 'finished_at', label: 'finished', fmt: (v) => v || '—' },
      { key: 'metrics', label: 'metrics', fmt: (v) => Object.entries(v || {}).filter(([, x]) => typeof x !== 'object').map(([k, x]) => `${k}=${x}`).join(' ') || '—' },
      { key: 'error', label: 'error', fmt: (v) => (v ? ui.c.red(v.message) : '') },
    ],
  );
  return m;
}

function registrySummary(quiet = false) {
  const conn = db.open();
  const r = db.one(conn, `SELECT COUNT(*) AS total, SUM(r.pushed_at IS NOT NULL) AS pushed, SUM(r.replied_at IS NOT NULL) AS replied, SUM(r.meeting_at IS NOT NULL) AS meetings, SUM(r.suppressed) AS suppressed,
                           SUM(r.pushed_at IS NULL AND r.suppressed=0 AND r.fit_score >= ${config.AUDIENCE_MIN_FIT_SCORE} AND (c.email IS NOT NULL OR c.linkedin_url IS NOT NULL)) AS eligible,
                           SUM(c.email IS NULL AND c.linkedin_url IS NULL) AS awaiting_contact_data
                           FROM audience_registry r LEFT JOIN contacts c ON c.contact_id = r.contact_id`);
  const seg = db.all(conn, 'SELECT segment, COUNT(*) AS n, SUM(pushed_at IS NOT NULL) AS pushed, SUM(replied_at IS NOT NULL) AS replied FROM audience_registry GROUP BY segment ORDER BY n DESC');
  if (!quiet) {
    ui.section('Outbound registry');
    ui.kv([
      ['profiles', ui.num(r.total)],
      ['pushed to a sequence', `${ui.num(r.pushed)}  (${ui.pct(r.pushed / r.total)})`],
      ['replied', `${ui.num(r.replied)}  (${ui.pct(r.replied / (r.pushed || 1))} of pushed)`],
      ['meetings', ui.num(r.meetings)],
      ['waiting for the daily cap', ui.num(r.eligible)],
      ['real people awaiting contact data', ui.num(r.awaiting_contact_data)],
      ['suppressed (do not contact)', ui.num(r.suppressed)],
    ]);
    ui.table(seg, [
      { key: 'segment', label: 'segment' },
      { key: 'n', label: 'profiles', align: 'right' },
      { key: 'pushed', label: 'pushed', align: 'right' },
      { key: 'replied', label: 'replied', align: 'right' },
      { key: (x) => (x.pushed ? x.replied / x.pushed : null), label: 'reply rate', align: 'right', fmt: (v) => ui.pct(v) },
    ]);
  }
  return { ...r, segments: seg };
}

module.exports = { runPipeline, status, registrySummary, STAGES, scoreCandidate };
