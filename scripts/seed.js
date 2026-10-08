'use strict';

/**
 * seed.js: builds the synthetic world for Lodestar Legal Finance.
 *
 * Nothing here is real. Firms, people, spend, touches, Salesforce objects,
 * loans and enquiries are all generated from one integer seed so every run
 * produces the same database and the same numbers.
 *
 * The generator is "person-centric": each contact accumulates marketing
 * exposure week by week, and the chance of an enquiry depends on that
 * exposure. That is what makes attribution worth doing on this data: the
 * channel that *caused* an enquiry is usually not the one Salesforce recorded.
 */

const { Rng } = require('../lib/rng');
const config = require('../lib/config');
const db = require('../lib/db');
const { ymd, iso, addDays, weekStart, weeksEnding, atTime, DAY } = require('../lib/dates');
const { logger } = require('../lib/logger');
const ui = require('../lib/ui');

const log = logger('seed');

// ---------------------------------------------------------------------------
// Vocabulary (all invented)
// ---------------------------------------------------------------------------

const CITIES = [
  ['London', 'London', 0.3], ['Manchester', 'North West', 0.08], ['Birmingham', 'West Midlands', 0.07],
  ['Leeds', 'Yorkshire', 0.06], ['Bristol', 'South West', 0.05], ['Liverpool', 'North West', 0.04],
  ['Newcastle', 'North East', 0.03], ['Sheffield', 'Yorkshire', 0.03], ['Nottingham', 'East Midlands', 0.03],
  ['Leicester', 'East Midlands', 0.02], ['Cardiff', 'Wales', 0.04], ['Swansea', 'Wales', 0.02],
  ['Reading', 'South East', 0.03], ['Brighton', 'South East', 0.03], ['Cambridge', 'East of England', 0.02],
  ['Norwich', 'East of England', 0.02], ['Exeter', 'South West', 0.02], ['Oxford', 'South East', 0.03],
  ['Southampton', 'South East', 0.03], ['York', 'Yorkshire', 0.02],
];
const OUT_OF_JURISDICTION = [
  ['Edinburgh', 'Scotland', 'Scotland'], ['Glasgow', 'Scotland', 'Scotland'], ['Belfast', 'Northern Ireland', 'Northern Ireland'],
];
const SURNAMES = ['Hartley', 'Finch', 'Pemberton', 'Ashcroft', 'Marlow', 'Rowe', 'Thackeray', 'Oakes', 'Whitlock', 'Bramwell',
  'Calloway', 'Dunmore', 'Ellery', 'Fairweather', 'Garside', 'Hollis', 'Inglewood', 'Jessop', 'Kinsale', 'Lockwood',
  'Mercer', 'Netherby', 'Ormsby', 'Prentice', 'Quarrie', 'Redfern', 'Sallow', 'Tremayne', 'Underhill', 'Vance',
  'Wexford', 'Yardley', 'Aldous', 'Beckford', 'Crossley', 'Danvers', 'Eastwood', 'Fenwick', 'Greaves', 'Hawtrey',
  'Okafor', 'Nandakumar', 'Osei', 'Petrova', 'Rahman', 'Szabo', 'Tan', 'Varga', 'Walsh', 'Zielinski', 'Achebe', 'Bianchi',
  'Chaudhry', 'Dlamini', 'Esposito', 'Fischer', 'Gallagher', 'Haddad', 'Iqbal', 'Jensen', 'Kowalski', 'Lindqvist',
  'Mensah', 'Novak', 'Olsen', 'Patel', 'Quinn', 'Rossi', 'Sato', 'Ueda', 'Vasquez', 'Williams', 'Xu', 'Yilmaz', 'Zhang'];
const FIRST = ['Priya', 'James', 'Amelia', 'Tom', 'Rachel', 'Daniel', 'Hannah', 'Oliver', 'Sophie', 'Ben', 'Chloe', 'Sam',
  'Fatima', 'Kwame', 'Elena', 'Marcus', 'Niamh', 'Arjun', 'Isla', 'Theo', 'Zara', 'Leo', 'Maya', 'Noah', 'Ruth', 'Adam',
  'Grace', 'Hugo', 'Aisha', 'Ewan', 'Lucy', 'Omar', 'Freya', 'Kai', 'Nadia', 'Rhys', 'Imogen', 'Yusuf', 'Carys', 'Jonah'];
const FIRM_SUFFIX = ['Solicitors', 'Solicitors LLP', 'Legal', 'Law', 'Family Law', 'Legal LLP', '& Co', 'Partners'];
const TITLES = {
  partner: ['Partner', 'Managing Partner', 'Senior Partner'],
  head_of_department: ['Head of Family', 'Head of Private Client', 'Head of Probate'],
  solicitor: ['Solicitor', 'Senior Associate', 'Associate Solicitor', 'Legal Director'],
  paralegal: ['Paralegal', 'Trainee Solicitor', 'Legal Assistant'],
  finance: ['Finance Manager', 'Practice Manager', 'COLP'],
};

const CHANNELS = Object.keys(config.LENDER.channels);

// What the Salesforce user tends to type into Lead Source, by true channel.
const LEAD_SOURCE_LABELS = {
  google_ads: { Web: 0.45, 'Google Ads': 0.4, '': 0.15 },
  linkedin_ads: { Web: 0.5, LinkedIn: 0.35, '': 0.15 },
  events: { Event: 0.7, Web: 0.2, '': 0.1 },
  solicitor_referral: { 'Solicitor Referral': 0.85, Web: 0.1, '': 0.05 },
  outbound_email: { Web: 0.45, Outbound: 0.3, Email: 0.1, '': 0.15 },
  organic_search: { Web: 0.75, Organic: 0.1, '': 0.15 },
  direct: { Web: 0.6, Phone: 0.25, '': 0.15 },
};

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function seed({ reset = true, quiet = false } = {}) {
  const rng = new Rng(config.SEED);
  const t0 = Date.now();
  if (reset) db.reset();
  const conn = db.open();

  const worldEnd = new Date(`${config.WORLD_END}T23:59:59.000Z`);
  const reportWeeks = weeksEnding(config.WORLD_END, config.WORLD_WEEKS); // 26 Mondays
  const touchWeeks = weeksEnding(config.WORLD_END, config.WORLD_WEEKS + 13); // +13 weeks of lookback history
  const say = quiet ? () => {} : ui.step;

  // ---- firms + contacts ---------------------------------------------------
  const firms = [];
  const contacts = [];
  const usedNames = new Set();
  const nFirms = 420;
  for (let i = 0; i < nFirms; i++) {
    let name;
    do {
      const a = rng.pick(SURNAMES);
      const b = rng.chance(0.55) ? ` & ${rng.pick(SURNAMES)}` : rng.chance(0.4) ? ` ${rng.pick(SURNAMES)}` : '';
      name = `${a}${b} ${rng.pick(FIRM_SUFFIX)}`;
    } while (usedNames.has(name));
    usedNames.add(name);
    const outside = rng.chance(0.05);
    const [city, region, jurisdiction] = outside
      ? rng.pick(OUT_OF_JURISDICTION)
      : (() => {
          const w = {};
          CITIES.forEach(([c, r, p]) => (w[`${c}|${r}`] = p));
          const [c, r] = rng.weighted(w).split('|');
          return [c, r, 'England and Wales'];
        })();
    const practice = rng.weighted({ family: 0.45, probate: 0.25, 'family,probate': 0.3 });
    const size = rng.weighted({ '1-5': 0.3, '6-20': 0.38, '21-50': 0.18, '51-200': 0.1, '200+': 0.04 });
    const domain = `${name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').slice(0, 24)}.co.uk`;
    const firm = {
      firm_id: rng.id('frm'),
      name,
      sra_number: String(rng.int(100000, 899999)),
      city,
      region,
      jurisdiction,
      practice_areas: practice,
      size_band: size,
      website_domain: domain,
      on_panel: !outside && rng.chance(0.12) ? 1 : 0,
      source: rng.weighted({ sra_register: 0.4, law_society: 0.25, companies_house: 0.1, events: 0.1, linkedin: 0.15 }),
      first_seen_at: iso(addDays(worldEnd, -rng.int(30, 720))),
    };
    firms.push(firm);

    const nContacts = { '1-5': [1, 2], '6-20': [2, 4], '21-50': [3, 5], '51-200': [4, 6], '200+': [5, 7] }[size];
    const count = rng.int(nContacts[0], nContacts[1]);
    const areas = practice.split(',');
    for (let k = 0; k < count; k++) {
      const role = k === 0 ? 'partner' : rng.weighted({ partner: 0.25, head_of_department: 0.15, solicitor: 0.4, paralegal: 0.12, finance: 0.08 });
      const fn = rng.pick(FIRST);
      const ln = rng.pick(SURNAMES);
      contacts.push({
        contact_id: rng.id('ctc'),
        firm_id: firm.firm_id,
        first_name: fn,
        last_name: ln,
        title: rng.pick(TITLES[role]),
        role_type: role,
        practice_area: role === 'finance' ? 'other' : rng.pick(areas),
        email: `${fn.toLowerCase()}.${ln.toLowerCase()}@${domain}`,
        linkedin_url: `https://www.linkedin.com/in/${fn.toLowerCase()}-${ln.toLowerCase()}-${rng.int(100, 999)}`,
        source: firm.source,
        first_seen_at: firm.first_seen_at,
      });
    }
  }
  db.insertMany(conn, 'firms', firms);
  db.insertMany(conn, 'contacts', contacts);
  say(`${firms.length} law firms, ${contacts.length} contacts`);

  const firmById = new Map(firms.map((f) => [f.firm_id, f]));

  // ---- audience registry (the outbound estate as it stands today) -----------
  const registry = [];
  for (const ct of contacts) {
    const firm = firmById.get(ct.firm_id);
    if (firm.jurisdiction !== 'England and Wales') continue;
    if (!['partner', 'head_of_department', 'solicitor'].includes(ct.role_type)) continue;
    if (ct.practice_area === 'other') continue;
    if (!rng.chance(0.7)) continue; // not everyone has been discovered yet
    const segment = firm.on_panel ? 'panel_expansion' : ct.practice_area === 'family' ? 'family_partners' : 'probate_partners';
    const fit = Math.max(3, Math.min(10, Math.round(rng.normal(ct.role_type === 'partner' ? 8 : 6.8, 1.4))));
    const qualifiedAt = addDays(worldEnd, -rng.int(5, 120));
    const pushed = fit >= config.AUDIENCE_MIN_FIT_SCORE && rng.chance(0.62);
    const pushedAt = pushed ? addDays(qualifiedAt, rng.int(1, 20)) : null;
    const replied = pushed && pushedAt < worldEnd && rng.chance(0.17);
    const repliedAt = replied ? addDays(pushedAt, rng.int(1, 12)) : null;
    const meeting = replied && rng.chance(0.35);
    registry.push({
      profile_key: ct.email.toLowerCase(),
      contact_id: ct.contact_id,
      firm_id: ct.firm_id,
      segment,
      fit_score: fit,
      qualified_at: iso(qualifiedAt),
      pushed_at: pushedAt && pushedAt < worldEnd ? iso(pushedAt) : null,
      sequencer: pushed ? (rng.chance(0.7) ? 'instantly' : 'heyreach') : null,
      sequencer_lead_id: pushed ? `seq_${rng.int(10000, 99999)}` : null,
      replied_at: repliedAt && repliedAt < worldEnd ? iso(repliedAt) : null,
      meeting_at: meeting ? iso(addDays(repliedAt, rng.int(2, 10))) : null,
      suppressed: rng.chance(0.03) ? 1 : 0,
      dedup_run_at: iso(addDays(worldEnd, -1)),
    });
  }
  db.insertMany(conn, 'audience_registry', registry);
  say(`${registry.length} profiles in the outbound registry`);

  // ---- ad spend by week --------------------------------------------------
  const spend = [];
  const eventWeeks = new Set([3, 9, 14, 20, 24, 31, 36].map((i) => touchWeeks[i]));
  for (const wk of touchWeeks) {
    const push = (channel, campaign, product, base, cpc, extra = {}) => {
      const amount = Math.max(0, base * (1 + rng.normal(0, 0.12)));
      const clicks = cpc ? Math.round(amount / (cpc * (1 + rng.normal(0, 0.1)))) : null;
      spend.push({
        spend_id: rng.id('spd', 8),
        week_start: wk,
        channel,
        campaign,
        product,
        spend_gbp: Math.round(amount * 100) / 100,
        impressions: clicks ? Math.round(clicks * rng.int(25, 60)) : extra.impressions || null,
        clicks,
        source: extra.source || 'ads_api',
      });
    };
    push('google_ads', 'search_family_law', 'family_law', 1850, 6.4);
    push('google_ads', 'search_probate', 'probate', 1250, 5.1);
    push('linkedin_ads', 'solicitor_partners_awareness', 'both', 1900, 11.5);
    push('outbound_email', 'sequencer_and_data', 'both', 450, null, { source: 'invoice' });
    push('organic_search', 'content_programme', 'both', 700, null, { source: 'invoice' });
    if (eventWeeks.has(wk)) push('events', 'regional_family_law_forum', 'both', 4500, null, { source: 'invoice', impressions: 120 });
  }
  db.insertMany(conn, 'ad_spend', spend);
  say(`${spend.length} weekly spend lines across ${new Set(spend.map((s) => s.channel)).size} channels`);

  // ---- touches, identity, enquiries, Salesforce objects, loans -------------
  const touches = [];
  const links = [];
  const leads = [];
  const opps = [];
  const history = [];
  const loans = [];
  const newInboundContacts = [];
  const newInboundFirms = [];

  const regByContact = new Map(registry.map((r) => [r.contact_id, r]));
  const weekIndex = new Map(touchWeeks.map((w, i) => [w, i]));
  const reportStart = new Date(`${reportWeeks[0]}T00:00:00.000Z`);

  let touchSeq = 0;
  const addTouch = (t) => {
    touchSeq++;
    touches.push({
      touch_id: `tch_${String(touchSeq).padStart(6, '0')}`,
      campaign: null,
      anon_id: null,
      contact_id: null,
      firm_id: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      landing_path: null,
      product_hint: null,
      cost_gbp: null,
      ...t,
      ts: iso(t.ts),
    });
  };
  const addLink = (anon_id, contact_id, method, confidence, at) =>
    links.push({ link_id: rng.id('lnk', 8), anon_id, contact_id, method, confidence, linked_at: iso(at) });

  // A person's web identity: usually one cookie, sometimes two devices.
  const identity = new Map();
  for (const ct of contacts) {
    identity.set(ct.contact_id, { primary: rng.id('anon', 10), secondary: rng.chance(0.22) ? rng.id('anon', 10) : null, linked: new Set() });
  }

  const CPC = { google_ads: 6.0, linkedin_ads: 11.5 };
  const UTM = {
    google_ads: (p) => ({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: p === 'probate' ? 'search_probate' : 'search_family_law', landing_path: p === 'probate' ? '/probate-loans' : '/family-law-loans' }),
    linkedin_ads: () => ({ utm_source: 'linkedin', utm_medium: 'paid_social', utm_campaign: 'solicitor_partners_awareness', landing_path: '/for-solicitors' }),
    organic_search: (p) => ({ utm_source: null, utm_medium: 'organic', landing_path: p === 'probate' ? '/guides/funding-inheritance-tax' : '/guides/financial-remedy-costs' }),
    outbound_email: () => ({ utm_source: 'sequencer', utm_medium: 'email', utm_campaign: 'partner_intro', landing_path: '/for-solicitors' }),
    events: () => ({ utm_source: 'event', utm_medium: 'offline', utm_campaign: 'regional_family_law_forum', landing_path: null }),
    solicitor_referral: () => ({ utm_source: null, utm_medium: 'referral', landing_path: null }),
    direct: () => ({ utm_source: null, utm_medium: 'none', landing_path: '/' }),
  };

  const HEAT = { impression: 0.02, click: 0.22, visit: 0.12, email_open: 0.04, email_click: 0.16, event_attend: 0.32, referral_intro: 0.55, call: 0.3 };
  const P_APP = { google_ads: 0.48, linkedin_ads: 0.42, events: 0.6, solicitor_referral: 0.72, outbound_email: 0.45, organic_search: 0.5, direct: 0.5 };

  let oppCounter = 0;
  const makeOpportunity = (ct, firm, product, enquiryAt, lastChannel) => {
    oppCounter++;
    const leadId = `00Q${String(100000 + oppCounter).padStart(9, '0')}`; // Salesforce-shaped ids
    const oppId = `006${String(100000 + oppCounter).padStart(9, '0')}`;
    const spec = config.LENDER.products[product];
    const amount = Math.round(Math.min(spec.max, Math.max(spec.min, rng.lognormal(product === 'probate' ? 45000 : 32000, product === 'probate' ? 0.7 : 0.6))) / 500) * 500;
    const leadSource = rng.weighted(LEAD_SOURCE_LABELS[lastChannel] || LEAD_SOURCE_LABELS.direct);

    // stage progression
    const stages = [['Enquiry', enquiryAt]];
    let stage = 'Enquiry';
    let at = enquiryAt;
    let lost = null;
    const tryStage = (next, p, minD, maxD) => {
      const nextAt = addDays(at, rng.int(minD, maxD));
      if (nextAt > worldEnd) return false; // still open in the pipeline
      if (rng.chance(p)) {
        stage = next;
        at = nextAt;
        stages.push([next, nextAt]);
        return true;
      }
      lost = rng.chance(0.6) ? 'Declined' : 'Withdrawn';
      stage = lost;
      at = nextAt;
      stages.push([lost, nextAt]);
      return false;
    };
    if (tryStage('Application', P_APP[lastChannel] || 0.5, 1, 9)) {
      if (tryStage('Offer', 0.7, 4, 18)) tryStage('Funded', 0.82, 3, 14);
    }
    const lostReason = lost ? rng.weighted({ 'Insufficient security': 0.35, 'Client found other funding': 0.25, 'Case settled': 0.2, 'Outside criteria': 0.2 }) : null;

    leads.push({
      lead_id: leadId,
      created_at: iso(enquiryAt),
      contact_id: ct.contact_id,
      firm_id: firm.firm_id,
      email: ct.email,
      lead_source: leadSource,
      product,
      status: 'Converted',
      converted_opportunity_id: oppId,
    });
    opps.push({
      opp_id: oppId,
      created_at: iso(enquiryAt),
      lead_id: leadId,
      contact_id: ct.contact_id,
      firm_id: firm.firm_id,
      product,
      stage,
      stage_entered_at: iso(at),
      amount_gbp: amount,
      close_date: stage === 'Funded' || lost ? ymd(at) : null,
      lost_reason: lostReason,
    });
    for (const [s, when] of stages) history.push({ history_id: rng.id('hst', 8), opp_id: oppId, stage: s, entered_at: iso(when) });
    if (stage === 'Funded') {
      loans.push({
        loan_id: `LN-${String(10000 + loans.length + 1)}`,
        opp_id: oppId,
        product,
        principal_gbp: amount,
        funded_at: iso(at),
        term_months: product === 'probate' ? 12 : rng.pick([12, 18, 24]),
      });
    }
    return oppId;
  };

  // --- A. registry contacts and panel partners accumulate exposure week by week
  let enquiriesFromContacts = 0;
  for (const ct of contacts) {
    const firm = firmById.get(ct.firm_id);
    if (firm.jurisdiction !== 'England and Wales' || ct.practice_area === 'other') continue;
    const reg = regByContact.get(ct.contact_id);
    const ids = identity.get(ct.contact_id);
    const product = ct.practice_area === 'probate' ? 'probate' : 'family_law';
    const isReferrer = firm.on_panel && ['partner', 'head_of_department', 'solicitor'].includes(ct.role_type);
    let heat = 0;
    let lastChannel = 'direct';
    let cooldown = 0;

    for (const wk of touchWeeks) {
      const wkDate = new Date(`${wk}T00:00:00.000Z`);
      const day = (off) => addDays(wkDate, off);
      const device = () => (ids.secondary && rng.chance(0.3) ? ids.secondary : ids.primary);
      cooldown = Math.max(0, cooldown - 1);

      // referral partners send cases without any marketing touch
      if (isReferrer && rng.chance(0.09)) {
        const at = atTime(ymd(day(rng.int(0, 4))), rng.float());
        addTouch({ ts: at, channel: 'solicitor_referral', touch_type: 'referral_intro', contact_id: ct.contact_id, firm_id: firm.firm_id, ...UTM.solicitor_referral(), product_hint: product });
        if (at >= reportStart || rng.chance(0.5)) {
          makeOpportunity(ct, firm, firm.practice_areas.includes(',') ? rng.weighted({ family_law: 0.6, probate: 0.4 }) : product, at, 'solicitor_referral');
          enquiriesFromContacts++;
        }
        continue;
      }

      // paid social reach for registry profiles
      if (reg && rng.chance(0.45)) {
        const at = atTime(ymd(day(rng.int(0, 6))), rng.float());
        addTouch({ ts: at, channel: 'linkedin_ads', touch_type: 'impression', anon_id: device(), ...UTM.linkedin_ads(), product_hint: 'both' });
        heat += HEAT.impression;
        if (rng.chance(0.06)) {
          const anon = device();
          addTouch({ ts: addDays(at, 0.01), channel: 'linkedin_ads', touch_type: 'click', anon_id: anon, ...UTM.linkedin_ads(), cost_gbp: CPC.linkedin_ads * (1 + rng.normal(0, 0.15)) });
          heat += HEAT.click;
          lastChannel = 'linkedin_ads';
        }
      }
      // intent search
      if (rng.chance(0.05)) {
        const at = atTime(ymd(day(rng.int(0, 6))), rng.float());
        const anon = device();
        addTouch({ ts: at, channel: 'google_ads', touch_type: 'click', anon_id: anon, ...UTM.google_ads(product), product_hint: product, cost_gbp: CPC.google_ads * (1 + rng.normal(0, 0.2)) });
        heat += HEAT.click;
        lastChannel = 'google_ads';
      }
      // organic content
      if (rng.chance(0.07)) {
        const at = atTime(ymd(day(rng.int(0, 6))), rng.float());
        addTouch({ ts: at, channel: 'organic_search', touch_type: 'visit', anon_id: device(), ...UTM.organic_search(product), product_hint: product });
        heat += HEAT.visit;
        lastChannel = 'organic_search';
      }
      // outbound sequence: opens and clicks in the weeks after pushed_at
      if (reg && reg.pushed_at && !reg.suppressed) {
        const pushedWk = weekIndex.get(ymd(weekStart(reg.pushed_at)));
        const i = weekIndex.get(wk);
        if (pushedWk !== undefined && i >= pushedWk && i <= pushedWk + 3) {
          const at = atTime(ymd(day(rng.int(0, 4))), rng.float(), 9, 17);
          if (rng.chance(0.55)) {
            addTouch({ ts: at, channel: 'outbound_email', touch_type: 'email_open', contact_id: ct.contact_id, firm_id: firm.firm_id, ...UTM.outbound_email() });
            heat += HEAT.email_open;
            if (rng.chance(0.25)) {
              const anon = device();
              addTouch({ ts: addDays(at, 0.002), channel: 'outbound_email', touch_type: 'email_click', anon_id: anon, contact_id: ct.contact_id, firm_id: firm.firm_id, ...UTM.outbound_email(), utm_content: 'cta_primary' });
              if (!ids.linked.has(anon)) {
                ids.linked.add(anon);
                addLink(anon, ct.contact_id, 'email_click_token', 0.95, at);
              }
              heat += HEAT.email_click;
              lastChannel = 'outbound_email';
            }
          }
        }
      }
      // events
      if (eventWeeks.has(wk) && rng.chance(reg ? 0.06 : 0.015)) {
        const at = atTime(ymd(day(3)), 0.4, 9, 10);
        addTouch({ ts: at, channel: 'events', touch_type: 'event_attend', contact_id: ct.contact_id, firm_id: firm.firm_id, ...UTM.events() });
        heat += HEAT.event_attend;
        lastChannel = 'events';
      }

      // conversion: the more exposure, the likelier an enquiry (with a cooldown after one)
      const pEnq = cooldown > 0 ? 0 : Math.min(0.55, heat * 0.16);
      if (heat > 0.1 && rng.chance(pEnq)) {
        const at = atTime(ymd(day(rng.int(0, 4))), rng.float(), 9, 18);
        const viaForm = rng.chance(0.8);
        const anon = device();
        if (viaForm) {
          // the web form is itself a touch: it carries the UTM of the converting session
          addTouch({ ts: at, channel: lastChannel, touch_type: 'form_submit', anon_id: anon, contact_id: ct.contact_id, firm_id: firm.firm_id, ...UTM[lastChannel](product), landing_path: '/apply', product_hint: product });
          if (!ids.linked.has(anon)) {
            ids.linked.add(anon);
            addLink(anon, ct.contact_id, 'form_email', 1.0, at);
          }
        } else if (!ids.linked.has(ids.primary) && rng.chance(0.5)) {
          // a phone enquiry leaves no web touch; sometimes the CRM email matches earlier web activity
          ids.linked.add(ids.primary);
          addLink(ids.primary, ct.contact_id, 'crm_match', 0.8, addDays(at, 1));
        }
        makeOpportunity(ct, firm, product, at, viaForm ? lastChannel : 'direct');
        enquiriesFromContacts++;
        heat = 0;
        cooldown = 6;
      } else {
        heat *= 0.82; // exposure fades
      }
    }
  }
  say(`${enquiriesFromContacts} enquiries from known contacts and referral partners`);

  // --- B. unknown inbound: people we had never seen until they filled in the form
  let inbound = 0;
  for (const wk of touchWeeks) {
    const wkDate = new Date(`${wk}T00:00:00.000Z`);
    const n = rng.int(9, 16);
    for (let k = 0; k < n; k++) {
      const product = rng.weighted({ family_law: 0.55, probate: 0.45 });
      const channel = rng.weighted({ google_ads: 0.5, organic_search: 0.35, linkedin_ads: 0.05, direct: 0.1 });
      const anon = rng.id('anon', 10);
      const steps = rng.int(1, 4);
      let at = atTime(ymd(addDays(wkDate, rng.int(0, 6))), rng.float());
      for (let s = 0; s < steps; s++) {
        const ch = s === steps - 1 ? channel : rng.weighted({ google_ads: 0.4, organic_search: 0.5, direct: 0.1 });
        const type = ch === 'google_ads' || ch === 'linkedin_ads' ? 'click' : 'visit';
        addTouch({ ts: at, channel: ch, touch_type: type, anon_id: anon, ...UTM[ch](product), product_hint: product, cost_gbp: type === 'click' ? CPC[ch] * (1 + rng.normal(0, 0.2)) : null });
        at = addDays(at, rng.int(0, 6) + rng.float());
      }
      if (at > worldEnd) continue;
      // new firm + contact appear at the moment of the form
      const fn = rng.pick(FIRST);
      const ln = rng.pick(SURNAMES);
      const base = rng.pick(firms.filter((f) => f.jurisdiction === 'England and Wales'));
      let firm = base;
      if (rng.chance(0.6)) {
        const name = `${ln} ${rng.pick(FIRM_SUFFIX)}`;
        const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24)}${rng.int(1, 99)}.co.uk`;
        firm = { ...base, firm_id: rng.id('frm'), name, sra_number: String(rng.int(100000, 899999)), website_domain: domain, on_panel: 0, source: 'inbound_form', first_seen_at: iso(at) };
        newInboundFirms.push(firm);
        firmById.set(firm.firm_id, firm);
      }
      const ct = {
        contact_id: rng.id('ctc'),
        firm_id: firm.firm_id,
        first_name: fn,
        last_name: ln,
        title: rng.pick(TITLES.solicitor),
        role_type: 'solicitor',
        practice_area: product === 'probate' ? 'probate' : 'family',
        email: `${fn.toLowerCase()}.${ln.toLowerCase()}@${firm.website_domain}`,
        linkedin_url: null,
        source: 'inbound_form',
        first_seen_at: iso(at),
      };
      newInboundContacts.push(ct);
      addTouch({ ts: at, channel, touch_type: 'form_submit', anon_id: anon, contact_id: ct.contact_id, firm_id: firm.firm_id, ...UTM[channel](product), landing_path: '/apply', product_hint: product });
      addLink(anon, ct.contact_id, 'form_email', 1.0, at);
      makeOpportunity(ct, firm, product, at, channel);
      inbound++;
    }
  }
  db.insertMany(conn, 'firms', newInboundFirms);
  db.insertMany(conn, 'contacts', newInboundContacts);
  say(`${inbound} enquiries from people we had never seen before`);

  // --- C. background traffic that never converts (most of the web)
  let noise = 0;
  for (const wk of touchWeeks) {
    const wkDate = new Date(`${wk}T00:00:00.000Z`);
    const perWeek = { google_ads: rng.int(330, 420), organic_search: rng.int(700, 950), linkedin_ads: rng.int(120, 180), direct: rng.int(80, 140) };
    for (const [ch, n] of Object.entries(perWeek)) {
      for (let k = 0; k < n; k++) {
        const product = rng.weighted({ family_law: 0.55, probate: 0.45 });
        const type = ch === 'google_ads' || ch === 'linkedin_ads' ? 'click' : 'visit';
        addTouch({ ts: atTime(ymd(addDays(wkDate, rng.int(0, 6))), rng.float(), 6, 23), channel: ch, touch_type: type, anon_id: rng.id('anon', 10), ...UTM[ch](product), product_hint: product, cost_gbp: type === 'click' ? CPC[ch] * (1 + rng.normal(0, 0.2)) : null });
        noise++;
      }
    }
  }

  touches.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  db.insertMany(conn, 'touches', touches);
  db.insertMany(conn, 'identity_links', links);
  db.insertMany(conn, 'sf_leads', leads);
  db.insertMany(conn, 'sf_opportunities', opps);
  db.insertMany(conn, 'sf_opportunity_history', history);
  db.insertMany(conn, 'loans', loans);
  say(`${touches.length.toLocaleString('en-GB')} touches (${noise.toLocaleString('en-GB')} anonymous), ${links.length} identity links`);
  say(`${leads.length} Salesforce leads → ${opps.length} opportunities → ${loans.length} funded loans`);

  // ---- signals on registry firms ------------------------------------------
  const signals = [];
  const SIGNALS = [
    ['new_partner', (f) => `${f.name} appoints new family law partner`, 8],
    ['new_office', (f) => `${f.name} opens second office in ${rng.pick(CITIES)[0]}`, 7],
    ['ranking', (f) => `${f.name} ranked for Family in the regional legal guide`, 6],
    ['job_ad', (f) => `${f.name} hiring: Private Client Solicitor (probate)`, 7],
    ['news', (f) => `${f.name} comments on court delays in financial remedy cases`, 5],
  ];
  const regFirms = [...new Set(registry.map((r) => r.firm_id))];
  for (let i = 0; i < 70; i++) {
    const firm = firmById.get(rng.pick(regFirms));
    const [type, headline, baseScore] = rng.pick(SIGNALS);
    const at = addDays(worldEnd, -rng.int(0, 56));
    signals.push({
      signal_id: rng.id('sig', 8),
      firm_id: firm.firm_id,
      contact_id: null,
      signal_type: type,
      headline: headline(firm),
      url: `https://www.${firm.website_domain}/news/${rng.int(100, 999)}`,
      score: Math.max(1, Math.min(10, baseScore + rng.int(-2, 2))),
      detected_at: iso(at),
      alerted_at: rng.chance(0.8) ? iso(addDays(at, 0.2)) : null,
    });
  }
  db.insertMany(conn, 'signals', signals);

  // ---- inbound enquiries with free text (the AI layer's input) -------------
  const enq = require('./seed-enquiries');
  const { enquiries, labels, humans } = enq.generate(rng, { firms: [...firms, ...newInboundFirms], worldEnd, count: 240 });
  db.insertMany(conn, 'enquiries', enquiries);
  db.insertMany(conn, 'enquiry_labels', labels);
  db.insertMany(conn, 'human_decisions', humans);
  say(`${enquiries.length} free-text enquiries with human decisions for the AI layer`);

  const ms = Date.now() - t0;
  log.info('seed complete', { firms: firms.length + newInboundFirms.length, contacts: contacts.length + newInboundContacts.length, touches: touches.length, opps: opps.length, loans: loans.length, enquiries: enquiries.length, ms });
  return { firms: firms.length + newInboundFirms.length, contacts: contacts.length + newInboundContacts.length, touches: touches.length, opps: opps.length, loans: loans.length, enquiries: enquiries.length, ms };
}

module.exports = { seed };

if (require.main === module) {
  ui.banner('Seeding the synthetic world', `${config.LENDER.name} · seed ${config.SEED}`);
  const r = seed({ reset: true });
  ui.ok(`done in ${r.ms} ms`);
}
