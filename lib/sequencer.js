'use strict';

/**
 * Sequencer adapter. The marketer owns the sequencing tool and the copy; the
 * engine only needs two verbs from whichever tool that is: push leads, read
 * statuses. This mock has the same shape as an Instantly / HeyReach client so
 * the real one is a drop-in (see docs/ARCHITECTURE.md → Integrations).
 *
 * No network calls are made from this file.
 */

const { Rng } = require('./rng');
const { fnv1a } = require('./hash');
const { logger } = require('./logger');

const log = logger('sequencer');

const CAMPAIGN_BY_SEGMENT = {
  family_partners: { tool: 'instantly', campaign: 'LLF · Family partners · intro' },
  probate_partners: { tool: 'instantly', campaign: 'LLF · Private client · intro' },
  mixed: { tool: 'instantly', campaign: 'LLF · Mixed practice · intro' },
  panel_expansion: { tool: 'heyreach', campaign: 'LLF · Panel firms · LinkedIn' },
};

/** @returns {Promise<Array<{profile_key, sequencer, sequencer_lead_id, campaign}>>} */
async function pushLeads(leads) {
  const out = [];
  for (const lead of leads) {
    const target = CAMPAIGN_BY_SEGMENT[lead.segment] || CAMPAIGN_BY_SEGMENT.mixed;
    const rng = new Rng(fnv1a(lead.profile_key));
    out.push({ profile_key: lead.profile_key, sequencer: target.tool, sequencer_lead_id: `${target.tool}_${rng.int(100000, 999999)}`, campaign: target.campaign });
  }
  log.info('pushed leads (mock)', { n: out.length });
  return out;
}

/**
 * Pull reply / meeting status for pushed leads. The mock turns about 3% of
 * previously silent leads into replies per sync and a third of those into meetings.
 * @returns {Promise<Array<{profile_key, replied_at, meeting_at}>>}
 */
async function fetchStatuses(leads, { asOf = new Date() } = {}) {
  const out = [];
  const day = asOf.toISOString().slice(0, 10);
  for (const lead of leads) {
    const rng = new Rng(fnv1a(`${lead.profile_key}|${day}`));
    if (rng.chance(0.03)) {
      const repliedAt = new Date(asOf.getTime() - rng.int(1, 48) * 3600000).toISOString();
      out.push({ profile_key: lead.profile_key, replied_at: repliedAt, meeting_at: rng.chance(0.33) ? asOf.toISOString() : null });
    }
  }
  log.info('fetched statuses (mock)', { checked: leads.length, replied: out.length });
  return out;
}

module.exports = { pushLeads, fetchStatuses, CAMPAIGN_BY_SEGMENT };
