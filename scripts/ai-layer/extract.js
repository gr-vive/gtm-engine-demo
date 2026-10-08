'use strict';

/**
 * The AI reader. Given one enquiry, returns the fields the rules need plus a
 * draft acknowledgement. Three providers, picked at runtime:
 *
 *   anthropic  live call via the Anthropic SDK; the response is cached as a fixture
 *   fixture    a cached response from an earlier live run (deterministic, free, offline)
 *   mock       a deterministic regex reader with built-in imperfection, so the
 *              shadow-mode evaluation still has something honest to measure when
 *              no API key and no fixtures are present. Always labelled as mock.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../lib/config');
const claude = require('../../lib/claude');
const { sha, fnv1a } = require('../../lib/hash');
const { Rng } = require('../../lib/rng');
const { logger } = require('../../lib/logger');

const log = logger('extract');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'jurisdiction', 'requested_gbp', 'security_gbp', 'hearing_in_days', 'has_solicitor', 'solicitor_firm', 'stage', 'summary', 'confidence', 'draft_reply'],
  properties: {
    product: { type: 'string', enum: ['family_law', 'probate', 'other', 'unclear'], description: 'What kind of matter the funding is for.' },
    jurisdiction: { type: 'string', enum: ['England and Wales', 'Scotland', 'Northern Ireland', 'other', 'unclear'], description: 'Where the proceedings or estate are. Infer from courts and towns only when explicit.' },
    requested_gbp: { type: ['number', 'null'], description: 'Amount of funding asked for, in GBP. null if not stated.' },
    security_gbp: { type: ['number', 'null'], description: 'Estate value (probate) or assets in dispute (family law), in GBP. null if not stated.' },
    hearing_in_days: { type: ['integer', 'null'], description: 'Days from the received date to the next hearing or tax deadline. null if none stated.' },
    has_solicitor: { type: 'boolean', description: 'true if a solicitor is instructed or the writer is a solicitor.' },
    solicitor_firm: { type: ['string', 'null'], description: 'Name of the law firm exactly as written, or null.' },
    stage: { type: ['string', 'null'], description: 'Stage of proceedings in a few words, or null.' },
    summary: { type: 'string', description: 'One sentence, plain English, no advice.' },
    confidence: { type: 'number', description: '0 to 1: how sure you are that the fields above are what the text says.' },
    draft_reply: { type: 'string', description: 'A short acknowledgement (3-5 sentences) that lists what we still need. Never promise an outcome, a rate or a timeline.' },
  },
};

function systemPrompt() {
  const L = config.LENDER;
  return [
    `You read inbound enquiries sent to ${L.name}, a specialist lender that funds legal costs in ${L.jurisdiction}.`,
    `Products: Family Law Loan (funds representation in divorce and financial remedy proceedings, secured on the assets in dispute) and Probate Loan (funds inheritance tax and costs while an estate is settled, secured on the estate).`,
    `Your job is to READ, not to decide. Extract only what the text states or clearly implies. If something is not there, return null or "unclear". Do not assess eligibility: coded rules do that after you.`,
    `Dates: the enquiry was received on the date given; convert any hearing or deadline date to a number of days from then.`,
    `Money: "45k" means 45000. Treat the amount the writer wants to borrow as requested_gbp and the value of the estate or the assets in dispute as security_gbp.`,
    `The draft reply is an acknowledgement for a human to edit. It must not promise an outcome, a rate, or a timeline, and must not give legal advice.`,
  ].join('\n');
}

function userPrompt(enquiry) {
  return `Received: ${enquiry.received_at.slice(0, 10)}\nChannel: ${enquiry.channel}\nFrom: ${enquiry.from_name || 'unknown'} <${enquiry.from_email || ''}>\nSubject: ${enquiry.subject || ''}\n\n${enquiry.raw_text}`;
}

const promptHash = (enquiry) => sha(`${config.PROMPT_VERSION}|${systemPrompt()}|${userPrompt(enquiry)}`);
const fixturePath = (enquiry) => path.join(config.FIXTURES_DIR, 'triage', config.PROMPT_VERSION, `${enquiry.enquiry_id}.json`);

// ---- providers ----------------------------------------------------------

async function viaAnthropic(enquiry) {
  const res = await claude.extractStructured({ system: systemPrompt(), user: userPrompt(enquiry), schema: SCHEMA, effort: 'low' });
  const out = {
    provider: 'anthropic',
    model: res.model,
    extracted: res.data,
    latency_ms: res.latency_ms,
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cost_usd: claude.estimateCostUsd(config.CLAUDE_MODEL, res.usage),
  };
  const fp = fixturePath(enquiry);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify({ ...out, prompt_hash: promptHash(enquiry), cached_at: new Date().toISOString() }, null, 2));
  return out;
}

function viaFixture(enquiry) {
  const fp = fixturePath(enquiry);
  if (!fs.existsSync(fp)) return null;
  const cached = JSON.parse(fs.readFileSync(fp, 'utf8'));
  return { ...cached, provider: 'fixture', latency_ms: 0, cost_usd: 0 };
}

const AMOUNT_RE = /(?:£\s?([\d,]+(?:\.\d+)?)\s*(k|m)?|(\d+)\s*(k)\b|around\s+(\d+)\s+thousand pounds)/gi;

function parseAmounts(text) {
  const out = [];
  let m;
  while ((m = AMOUNT_RE.exec(text))) {
    let v;
    if (m[1]) v = parseFloat(m[1].replace(/,/g, '')) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1000 : 1e6) : 1);
    else if (m[3]) v = parseFloat(m[3]) * 1000;
    else if (m[5]) v = parseFloat(m[5]) * 1000;
    if (v) out.push({ v, idx: m.index, ctx: text.slice(Math.max(0, m.index - 45), m.index + 30).toLowerCase() });
  }
  return out;
}

/** Deterministic regex reader with deliberate blind spots. */
function viaMock(enquiry) {
  const rng = new Rng(fnv1a(enquiry.enquiry_id + config.PROMPT_VERSION));
  const text = enquiry.raw_text;
  const lower = text.toLowerCase();
  const started = Date.now();

  let product = 'unclear';
  if (/probate|estate|executor|inheritance|iht|grant/.test(lower)) product = 'probate';
  else if (/financial remedy|matrimonial|divorce|family court|fdr|children|ex has|pursuer|financial provision/.test(lower)) product = 'family_law';
  if (/personal injury|commercial dispute|employment tribunal|professional negligence|unfair dismissal/.test(lower)) product = 'other';

  let jurisdiction = 'unclear';
  if (/scotland|sheriff|court of session|edinburgh|glasgow|pursuer/.test(lower)) jurisdiction = 'Scotland';
  else if (/northern ireland|belfast/.test(lower)) jurisdiction = 'Northern Ireland';
  else if (/family court|court|estate|executor|solicitor|llp|matrimonial|divorce/.test(lower)) jurisdiction = 'England and Wales';

  const amounts = parseAmounts(text);
  let requested = null;
  let security = null;
  for (const a of amounts) {
    const before = a.ctx.slice(0, 45);
    const isSecurity = /assets|estate|valued|worth|pot is|equity|property|pension|gross value|matrimonial|house|home/.test(before);
    const isRequest = /need|require|borrow|loan|fund|costs|facility|cover|fee|bill|looking at|pay|tax/.test(before);
    if (isSecurity && security == null) security = a.v;
    else if (isRequest && requested == null) requested = a.v;
    else if (requested == null) requested = a.v;
    else if (security == null) security = a.v;
  }
  // blind spot 1: when both numbers sit in one sentence the mock sometimes swaps them
  if (requested != null && security != null && rng.chance(0.08)) [requested, security] = [security, requested];

  let hearing = null;
  const dm = /(?:listed for|hearing on|hearing|due by|deadline is|next hearing)\s+(\d{1,2}\s+[A-Z][a-z]+)/.exec(text);
  if (dm) {
    const year = enquiry.received_at.slice(0, 4);
    const d = new Date(`${dm[1]} ${year} UTC`);
    if (!Number.isNaN(d.getTime())) {
      let days = Math.round((d - new Date(enquiry.received_at)) / 86400000);
      if (days < -30) days += 365;
      hearing = days;
    }
  }
  // blind spot 2: occasionally misses the date entirely
  if (hearing != null && rng.chance(0.06)) hearing = null;

  const noSolicitor = /representing myself|litigant in person|can't afford a solicitor|lend to me directly/.test(lower);
  const hasSolicitor = !noSolicitor && /solicitor|llp|we act|i act|act for|instructed|partner|associate|legal|law\b|head of|& co|our client|my client|we have a client|executors|administering/.test(lower);
  const fm = /(?:^|\n)[A-Za-z ,]*?,\s*([A-Z][A-Za-z&' ]+(?:Solicitors LLP|Solicitors|Legal LLP|Legal|Law|Family Law|& Co|Partners))/m.exec(text) || /solicitors are ([A-Z][A-Za-z&' ]+?)(?: and|\.)/.exec(text);
  const firm = hasSolicitor && fm ? fm[1].trim() : null;

  const extracted = {
    product,
    jurisdiction,
    requested_gbp: requested,
    security_gbp: security,
    hearing_in_days: hearing,
    has_solicitor: hasSolicitor,
    solicitor_firm: firm,
    stage: /fdr/.test(lower) ? 'FDR listed' : /final hearing/.test(lower) ? 'approaching final hearing' : /grant/.test(lower) ? 'pre-grant' : null,
    summary: `${product === 'unclear' ? 'Unclear' : product.replace('_', ' ')} enquiry${requested ? ` for £${requested.toLocaleString('en-GB')}` : ''}${firm ? ` from ${firm}` : ''}.`,
    confidence: Math.round((0.6 + rng.float() * 0.35) * 100) / 100,
    draft_reply: (() => {
      const needs = [];
      if (requested == null) needs.push('the amount of funding required');
      if (security == null) needs.push(product === 'probate' ? 'an estimate of the estate value' : 'an estimate of the assets in dispute');
      if (!hasSolicitor) needs.push('details of the solicitor instructed');
      needs.push(needs.length ? 'any key dates' : 'the supporting documents listed in our criteria, and any key dates');
      return `Thank you for your enquiry. We have logged it and a member of the ${product === 'probate' ? 'probate' : 'family law'} team will come back to you. To take it further we will need ${needs.join(', ')}. We cannot confirm terms until we have reviewed the information.`;
    })(),
  };
  return { provider: 'mock', model: 'mock-regex-reader', extracted, latency_ms: Date.now() - started, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
}

/**
 * @param {object} enquiry row from `enquiries`
 * @param {object} opts { mode: 'auto' | 'live' | 'fixtures' | 'mock' }
 */
async function extractEnquiry(enquiry, opts = {}) {
  const mode = opts.mode || 'auto';
  let out = null;
  if (mode === 'live' || (mode === 'auto' && claude.hasKey())) {
    if (!claude.hasKey()) throw new Error('--live requested but ANTHROPIC_API_KEY is not set');
    out = await viaAnthropic(enquiry);
  } else if (mode !== 'mock') {
    out = viaFixture(enquiry);
  }
  if (!out) {
    if (mode === 'fixtures') throw new Error(`no fixture for ${enquiry.enquiry_id}; run with --live once to create it`);
    out = viaMock(enquiry);
  }
  log.info(`extracted ${enquiry.enquiry_id}`, { provider: out.provider, model: out.model, latency_ms: out.latency_ms });
  return { ...out, prompt_hash: promptHash(enquiry), prompt_version: config.PROMPT_VERSION };
}

module.exports = { extractEnquiry, SCHEMA, systemPrompt, userPrompt, promptHash };
