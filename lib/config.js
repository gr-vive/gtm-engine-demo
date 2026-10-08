'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// .env is optional. Everything has a safe default.
try {
  require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
} catch (_) {
  /* dotenv not installed yet: defaults below still apply */
}

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

const config = {
  ROOT,
  DB_PATH: path.resolve(ROOT, env('GTM_DB_PATH', 'data/gtm.db')),
  SQL_DIR: path.join(ROOT, 'sql'),
  RUNS_DIR: path.join(ROOT, 'runs'),
  LOGS_DIR: path.join(ROOT, 'logs'),
  REPORTS_DIR: path.join(ROOT, 'reports'),
  FIXTURES_DIR: path.join(ROOT, 'data', 'fixtures'),
  SITE_DIR: path.join(ROOT, 'site'),

  SEED: Number(env('SEED', 20261008)),

  // Fictional lender. Everything about it is invented.
  LENDER: {
    name: 'Lodestar Legal Finance',
    short: 'Lodestar',
    jurisdiction: 'England and Wales',
    products: {
      family_law: { label: 'Family Law Loan', min: 5000, max: 250000, cover_ratio: 2.0, max_ltv: 0.5 },
      probate: { label: 'Probate Loan', min: 5000, max: 500000, cover_ratio: 3.0, max_ltv: 0.33 },
    },
    channels: {
      google_ads: 'Google Ads',
      linkedin_ads: 'LinkedIn Ads',
      events: 'Events',
      solicitor_referral: 'Solicitor referral',
      outbound_email: 'Outbound email',
      organic_search: 'Organic search',
      direct: 'Direct',
    },
    stages: ['Enquiry', 'Application', 'Offer', 'Funded'],
    lost_stages: ['Declined', 'Withdrawn'],
  },

  // AI layer
  ANTHROPIC_API_KEY: env('ANTHROPIC_API_KEY', ''),
  CLAUDE_MODEL: env('CLAUDE_MODEL', 'claude-opus-5'),
  CLAUDE_FALLBACKS: env('CLAUDE_FALLBACKS', '0') === '1',
  AI_MODE: env('AI_MODE', 'shadow'), // shadow | assist
  PROMPT_VERSION: 'triage-v3',

  // Delivery
  SLACK_WEBHOOK_URL: env('SLACK_WEBHOOK_URL', ''),
  SLACK_SIGNALS_WEBHOOK_URL: env('SLACK_SIGNALS_WEBHOOK_URL', ''),

  // Caps and windows
  AUDIENCE_DAILY_PUSH_CAP: Number(env('AUDIENCE_DAILY_PUSH_CAP', 40)),
  AUDIENCE_MIN_FIT_SCORE: Number(env('AUDIENCE_MIN_FIT_SCORE', 7)),
  ATTRIBUTION_LOOKBACK_DAYS: Number(env('ATTRIBUTION_LOOKBACK_DAYS', 90)),

  // The synthetic world ends on this Sunday (last complete ISO week).
  WORLD_END: '2026-10-04',
  WORLD_WEEKS: 26,
};

for (const d of [config.RUNS_DIR, config.LOGS_DIR, config.REPORTS_DIR, path.dirname(config.DB_PATH)]) {
  fs.mkdirSync(d, { recursive: true });
}

module.exports = config;
