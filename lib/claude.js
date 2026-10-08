'use strict';

/**
 * Thin wrapper around the official Anthropic SDK.
 *
 * One job: ask Claude for a JSON object that matches a schema, and return it
 * with usage, latency and the model that actually answered. Everything else
 * (prompts, caching to fixtures, rules) lives in the calling module.
 */

const config = require('./config');
const { logger } = require('./logger');

const log = logger('claude');

// USD per million tokens (input, output). Used only for the cost column in the audit log.
const PRICING = {
  'claude-opus-5': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-4-6': [3, 15],
};

let _client = null;
function getClient() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk');
  // Resolves ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.
  _client = new Anthropic();
  return _client;
}

const hasKey = () => Boolean(config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

function estimateCostUsd(model, usage) {
  const [inp, out] = PRICING[model] || PRICING['claude-opus-5'];
  return ((usage.input_tokens || 0) * inp + (usage.output_tokens || 0) * out) / 1e6;
}

function parseJsonText(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(cleaned);
}

/**
 * @param {object} p { system, user, schema, maxTokens, effort }
 * @returns {Promise<{data, usage, model, latency_ms, stop_reason}>}
 */
async function extractStructured({ system, user, schema, maxTokens = 4000, effort = 'low' }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = getClient();
  const model = config.CLAUDE_MODEL;
  const started = Date.now();

  const base = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  };

  let response;
  try {
    if (config.CLAUDE_FALLBACKS) {
      // Server-side refusal fallback (beta): if a safety classifier declines, the
      // API re-runs the request on a fallback model inside the same call.
      response = await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } else {
      response = await client.messages.create(base);
    }
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError && /output_config|format/i.test(err.message)) {
      // Structured outputs unavailable for this model/account: fall back to a plain
      // JSON instruction and parse the text ourselves.
      log.warn('structured outputs rejected, retrying with plain JSON instruction', { model, message: err.message });
      const { output_config: _oc, ...plain } = base;
      response = await client.messages.create({ ...plain, system: `${system}\n\nReturn only a JSON object matching this schema, no prose:\n${JSON.stringify(schema)}` });
    } else throw err;
  }

  if (response.stop_reason === 'refusal') {
    const details = response.stop_details ? `${response.stop_details.category}: ${response.stop_details.explanation}` : 'no details';
    throw new Error(`model refused the request (${details})`);
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = parseJsonText(text);
  const usage = { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens };
  return { data, usage, model: response.model || model, latency_ms: Date.now() - started, stop_reason: response.stop_reason };
}

module.exports = { getClient, hasKey, extractStructured, estimateCostUsd, PRICING };
