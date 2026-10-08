'use strict';

/**
 * Companies House public register connector (the one live source in this repo).
 *
 * Finds active solicitor firms (SIC 69102) whose name matches a query, then the
 * active officers (directors, LLP members) of each. Everything returned is public
 * register data: company name and number, registered office, officer names and
 * roles. No emails, no phone numbers; enrichment never invents them for real people.
 *
 * Auth: HTTP Basic, API key as username, empty password.
 * Limits: 600 requests per 5 minutes per key. One run here uses about 30.
 * Docs: https://developer-specs.company-information.service.gov.uk/
 */

const config = require('../config');
const { logger } = require('../logger');

const log = logger('companies-house');
const BASE = 'https://api.company-information.service.gov.uk';
const OFFICER_ROLES = new Set(['director', 'llp-member', 'llp-designated-member', 'member', 'managing-officer']);

function enabled() {
  return Boolean(config.COMPANIES_HOUSE_API_KEY);
}

async function get(path, params = {}) {
  if (!enabled()) throw new Error('COMPANIES_HOUSE_API_KEY is not set');
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const headers = { Authorization: 'Basic ' + Buffer.from(`${config.COMPANIES_HOUSE_API_KEY}:`).toString('base64'), Accept: 'application/json' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      const wait = 2000 * attempt;
      log.warn('rate limited, waiting', { path, wait });
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Companies House ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`Companies House rate limit persisted on ${path}`);
}

/** "SURNAME, Forename Middle" → { first, last } */
function parseName(raw) {
  const s = String(raw || '').trim();
  if (s.includes(',')) {
    const [last, rest] = s.split(',').map((x) => x.trim());
    const first = (rest || '').split(/\s+/)[0] || '';
    return { first: titleCase(first), last: titleCase(last) };
  }
  const parts = s.split(/\s+/);
  return { first: titleCase(parts[0] || ''), last: titleCase(parts.slice(1).join(' ') || '') };
}
/** Register names are ALL CAPS. Title-case them, keeping short vowel-less tokens (LB, JM, CSP) and legal suffixes as acronyms. */
const SUFFIX = { llp: 'LLP', ltd: 'Ltd', plc: 'PLC', 'ltd.': 'Ltd.' };
function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => {
      const core = w.replace(/[()]/g, '');
      if (SUFFIX[core]) return w.replace(core, SUFFIX[core]);
      if (/^[a-z]{1,3}$/.test(core) && !/[aeiouy]/.test(core)) return w.replace(core, core.toUpperCase());
      return w.replace(/(^|[(\s'.-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
    })
    .join('');
}

/** Jurisdiction from the company number prefix, then the registered office country. */
function jurisdictionOf(company) {
  const n = String(company.company_number || '');
  if (/^(SC|SO|SF|SL)/.test(n)) return 'Scotland';
  if (/^(NI|NC|NL|NF)/.test(n)) return 'Northern Ireland';
  const country = (company.registered_office_address || {}).country || '';
  if (/scotland/i.test(country)) return 'Scotland';
  if (/northern ireland/i.test(country)) return 'Northern Ireland';
  return 'England and Wales';
}

function practiceOf(name) {
  const n = name.toLowerCase();
  const fam = /family|divorce|matrimonial|children/.test(n);
  const pro = /probate|wills?\b|estate|private client|trust/.test(n);
  return fam && pro ? 'family,probate' : fam ? 'family' : pro ? 'probate' : 'mixed';
}

async function searchCompanies({ nameIncludes, sic = '69102', status = 'active', size = 20 }) {
  const data = await get('/advanced-search/companies', { company_name_includes: nameIncludes, sic_codes: sic, company_status: status, size });
  return (data && data.items) || [];
}

async function officers(companyNumber, { max = 3 } = {}) {
  const data = await get(`/company/${companyNumber}/officers`, { items_per_page: 35, register_type: 'directors' });
  const items = (data && data.items) || [];
  return items
    .filter((o) => !o.resigned_on && OFFICER_ROLES.has(o.officer_role))
    .slice(0, max)
    .map((o) => {
      const link = (((o.links || {}).officer || {}).appointments || '').match(/\/officers\/([^/]+)\//);
      return { ...parseName(o.name), raw_name: o.name, role: o.officer_role, appointed_on: o.appointed_on, officer_id: link ? link[1] : null };
    });
}

/**
 * @returns {Promise<Array<{company, officers}>>} real firms with their active officers
 */
async function discoverLawFirms({ queries = ['family law', 'probate'], companiesPerQuery = 8, officersPerCompany = 3 } = {}) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const items = await searchCompanies({ nameIncludes: q, size: companiesPerQuery });
    for (const c of items) {
      if (seen.has(c.company_number)) continue;
      seen.add(c.company_number);
      const people = await officers(c.company_number, { max: officersPerCompany });
      out.push({
        company: {
          company_number: c.company_number,
          name: titleCase(c.company_name || ''),
          status: c.company_status,
          sic_codes: c.sic_codes || [],
          city: (c.registered_office_address || {}).locality || null,
          region: (c.registered_office_address || {}).region || null,
          postcode: (c.registered_office_address || {}).postal_code || null,
          incorporated: c.date_of_creation || null,
          jurisdiction: jurisdictionOf(c),
          practice_areas: practiceOf(c.company_name || ''),
          url: `https://find-and-update.company-information.service.gov.uk/company/${c.company_number}`,
        },
        officers: people,
      });
    }
  }
  log.info('companies house discovery', { queries, companies: out.length, officers: out.reduce((s, x) => s + x.officers.length, 0) });
  return out;
}

module.exports = { enabled, searchCompanies, officers, discoverLawFirms, parseName, jurisdictionOf, practiceOf };
