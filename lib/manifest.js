'use strict';

/**
 * Staged, checkpointed runs.
 *
 * Every pipeline run gets runs/<kind>/<run_id>/manifest.json with one entry per
 * stage (pending | running | completed | failed), attempt counts, timings and
 * metrics. A failed run is resumed from the failed stage, not from the start.
 * This is what "what happens when it breaks" looks like in practice.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logger } = require('./logger');

const log = logger('manifest');
const now = () => new Date().toISOString();

function runDir(kind, runId) {
  return path.join(config.RUNS_DIR, kind, runId);
}

function newRunId(kind) {
  return `${now().replace(/[-:.TZ]/g, '').slice(0, 14)}_${kind}`;
}

function create(kind, stages, { runId } = {}) {
  const id = runId || newRunId(kind);
  const manifest = {
    run_id: id,
    kind,
    created_at: now(),
    updated_at: now(),
    status: 'running',
    current_stage: null,
    stages: Object.fromEntries(stages.map((s) => [s, { status: 'pending', attempts: 0, started_at: null, finished_at: null, error: null, metrics: {} }])),
    stage_order: stages,
    metrics: {},
  };
  fs.mkdirSync(runDir(kind, id), { recursive: true });
  save(manifest);
  log.info('run created', { kind, run_id: id });
  return manifest;
}

function load(kind, runId) {
  const file = path.join(runDir(kind, runId), 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`no run ${runId} under runs/${kind}/`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function latest(kind) {
  const dir = path.join(config.RUNS_DIR, kind);
  if (!fs.existsSync(dir)) return null;
  const ids = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'manifest.json'))).sort();
  return ids.length ? load(kind, ids.at(-1)) : null;
}

function save(m) {
  m.updated_at = now();
  const file = path.join(runDir(m.kind, m.run_id), 'manifest.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, file); // atomic on the same filesystem
}

function artifact(m, name, data) {
  const file = path.join(runDir(m.kind, m.run_id), name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function readArtifact(m, name) {
  const file = path.join(runDir(m.kind, m.run_id), name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function nextStage(m) {
  return m.stage_order.find((s) => ['pending', 'running', 'failed'].includes(m.stages[s].status)) || null;
}

/**
 * Run one stage with bookkeeping. `fn(m)` returns metrics. Throws on failure
 * after recording it, so the caller decides whether to stop or continue.
 */
async function runStage(m, stage, fn, { force = false } = {}) {
  const s = m.stages[stage];
  if (s.status === 'completed' && !force) {
    log.info('stage skipped (already completed)', { run_id: m.run_id, stage });
    return { skipped: true, metrics: s.metrics };
  }
  s.status = 'running';
  s.attempts += 1;
  s.started_at = now();
  s.error = null;
  m.current_stage = stage;
  save(m);
  try {
    const metrics = (await fn(m)) || {};
    s.status = 'completed';
    s.finished_at = now();
    s.metrics = metrics;
    Object.assign(m.metrics, metrics);
    if (!nextStage(m)) m.status = 'completed';
    save(m);
    log.info('stage completed', { run_id: m.run_id, stage, metrics });
    return { skipped: false, metrics };
  } catch (err) {
    s.status = 'failed';
    s.finished_at = now();
    s.error = { message: err.message, stack: (err.stack || '').split('\n').slice(0, 4).join('\n') };
    m.status = 'failed';
    save(m);
    log.error('stage failed', { run_id: m.run_id, stage, error: err.message });
    throw err;
  }
}

module.exports = { create, load, latest, save, artifact, readArtifact, nextStage, runStage, runDir };
