'use strict';

const { spawn } = require('node:child_process');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { configureHttp, clampInt } = require('./http.cjs');

const PROVIDERS_DIR = path.join(__dirname, 'providers');
const WORKER_PATH = path.join(__dirname, 'worker.cjs');
const CONFIG_PATH = path.join(__dirname, 'config', 'app-config.json');

function loadConfig(configPath = CONFIG_PATH) {
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuração JSON inválida.');
  return parsed;
}

function listProviders(config = loadConfig()) {
  const available = fs.readdirSync(PROVIDERS_DIR)
    .filter((name) => /^[a-z0-9][a-z0-9_-]{0,63}\.js$/.test(name))
    .map((name) => name.slice(0, -3));
  const availableSet = new Set(available);
  const priority = Array.isArray(config.PROVIDER_SEARCH_PRIORITY)
    ? config.PROVIDER_SEARCH_PRIORITY.map(String).filter((id, index, values) => values.indexOf(id) === index && availableSet.has(id))
    : [];
  const prioritized = new Set(priority);
  return [...priority, ...available.filter((id) => !prioritized.has(id)).sort()];
}

function displayName(id) {
  return String(id).split(/[-_]+/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ');
}

function validatePayload(body) {
  const tmdbId = String(body?.tmdbId || '').trim();
  const mediaType = String(body?.mediaType || body?.type || '').toLowerCase();
  if (!/^\d{1,12}$/.test(tmdbId)) throw Object.assign(new Error('tmdbId deve ser numérico.'), { status: 400 });
  if (!['movie', 'tv'].includes(mediaType)) throw Object.assign(new Error('mediaType deve ser movie ou tv.'), { status: 400 });
  const season = body?.season == null ? null : clampInt(body.season, 0, 1, 100);
  const episode = body?.episode == null ? null : clampInt(body.episode, 0, 1, 10_000);
  if (mediaType === 'tv' && ((season == null) !== (episode == null))) throw Object.assign(new Error('Informe season e episode juntos.'), { status: 400 });
  return { tmdbId, mediaType, season, episode };
}

function acquireSlot(state) {
  if (state.active < state.maximum) { state.active += 1; return Promise.resolve(); }
  return new Promise((resolve) => state.waiters.push(() => { state.active += 1; resolve(); }));
}

function releaseSlot(state) {
  state.active = Math.max(0, state.active - 1);
  const next = state.waiters.shift();
  if (next) next();
}

function mapStreams(streams, providerId) {
  if (!Array.isArray(streams)) return [];
  return streams.slice(0, 100).flatMap((stream) => {
    const rawUrl = String(stream?.url || stream?.externalUrl || '').trim();
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return []; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return [];
    const rawHeaders = stream?.headers && typeof stream.headers === 'object' ? stream.headers : {};
    const headers = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      const normalized = key.toLowerCase();
      if (['user-agent', 'referer', 'origin'].includes(normalized) && typeof value === 'string') headers[key] = value.slice(0, 2000);
    }
    const output = {
      provider: displayName(providerId),
      url: parsed.toString(),
      title: String(stream?.title || stream?.name || displayName(providerId)).slice(0, 300),
      quality: String(stream?.quality || '').slice(0, 40),
      type: String(stream?.type || '').slice(0, 40),
      language: String(stream?.language || '').slice(0, 40)
    };
    if (Object.keys(headers).length) output.headers = headers;
    return [output];
  });
}

function createApp({ config = loadConfig() } = {}) {
  const app = express();
  const providers = listProviders(config);
  const allowed = new Set(providers);
  const concurrency = clampInt(config.MAX_PROVIDER_WORKERS, 4, 1, 8);
  const timeoutMs = clampInt(config.PROVIDER_SOURCE_TIMEOUT_MS, 25_000, 1_000, 30_000);
  const outputLimit = 1_000_000;
  const slots = { active: 0, maximum: concurrency, waiters: [] };

  configureHttp(app, 'iracemaflix-providers-api', config, { rateLimit: 20 });
  app.use('/api/v1', express.json({ limit: '12kb', strict: true }));
  app.get('/openapi.json', (_req, res) => res.type('application/json').sendFile(path.join(__dirname, 'openapi.json')));

  function runProvider(providerId, payload, req) {
    return new Promise(async (resolve, reject) => {
      await acquireSlot(slots);
      const childEnv = { PATH: '/usr/bin:/bin', HOME: '/tmp', NODE_ENV: 'production' };
      const child = spawn(process.execPath, ['--max-old-space-size=96', WORKER_PATH], {
        cwd: __dirname, env: childEnv, stdio: ['pipe', 'pipe', 'ignore']
      });
      let stdout = '';
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req?.off('aborted', abort);
        releaseSlot(slots);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => {
        child.kill('SIGKILL');
        finish(Object.assign(new Error('Requisição cancelada.'), { status: 499 }));
      };
      req?.once('aborted', abort);
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(Object.assign(new Error('Tempo limite do provider excedido.'), { status: 504 }));
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on('data', (chunk) => {
        if (stdout.length + chunk.length > outputLimit) {
          child.kill('SIGKILL');
          finish(Object.assign(new Error('Provider excedeu o limite de resposta.'), { status: 502 }));
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.once('error', () => finish(Object.assign(new Error('Não foi possível iniciar o worker.'), { status: 502 })));
      child.once('close', () => {
        if (settled) return;
        try {
          const result = JSON.parse(stdout.trim());
          if (!result || !Array.isArray(result.streams)) throw new Error('invalid_result');
          finish(null, { ok: Boolean(result.ok), streams: mapStreams(result.streams, providerId), error: result.ok ? undefined : 'provider_error' });
        } catch {
          finish(Object.assign(new Error('Resposta inválida do worker.'), { status: 502 }));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({
        providerId,
        ...payload,
        tmdbApiKey: String(config.TMDB_API_KEY ?? ''),
        providerSourceTimeoutMs: config.PROVIDER_SOURCE_TIMEOUT_MS,
        directProviderApiTimeoutMs: config.DIRECT_PROVIDER_API_TIMEOUT_MS
      }));
    });
  }

  app.get('/api/v1/providers', (_req, res) => {
    res.json({ providers: providers.map((id) => ({ id, name: displayName(id) })) });
  });

  app.post('/api/v1/providers/:providerId/streams', async (req, res, next) => {
    const providerId = String(req.params.providerId || '');
    if (!allowed.has(providerId)) return res.status(404).json({ error: 'Provider não encontrado', requestId: req.requestId });
    let payload;
    try { payload = validatePayload(req.body); } catch (error) { return res.status(error.status || 400).json({ error: error.message, requestId: req.requestId }); }
    try {
      const result = await runProvider(providerId, payload, req);
      return res.json({ provider: { id: providerId, name: displayName(providerId) }, ...result });
    } catch (error) { return next(error); }
  });

  app.post('/api/v1/search', async (req, res) => {
    let payload;
    try { payload = validatePayload(req.body); } catch (error) { return res.status(error.status || 400).json({ error: error.message, requestId: req.requestId }); }
    const ids = Array.isArray(req.body?.providerIds) ? [...new Set(req.body.providerIds.map(String))].slice(0, 8) : [];
    if (!ids.length) return res.status(400).json({ error: 'providerIds deve conter de 1 a 8 IDs.', requestId: req.requestId });
    if (ids.some((id) => !allowed.has(id))) return res.status(400).json({ error: 'Um ou mais providers não existem.', requestId: req.requestId });
    const results = await Promise.all(ids.map(async (id) => {
      try { return { id, ...(await runProvider(id, payload, req)) }; }
      catch (error) { return { id, ok: false, streams: [], error: error.status === 504 ? 'timeout' : 'provider_error' }; }
    }));
    res.json({ results, streams: results.flatMap((result) => result.streams || []) });
  });

  app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada', requestId: req.requestId }));
  app.use((err, req, res, _next) => {
    if (res.headersSent) return res.end();
    const candidate = Number(err?.statusCode || err?.status);
    const status = candidate >= 400 && candidate < 600 ? candidate : 500;
    res.status(status).json({ error: status === 500 ? 'Erro interno do serviço' : String(err.message || 'Falha na requisição'), requestId: req?.requestId });
  });
  return app;
}

if (require.main === module) {
  const config = loadConfig();
  const port = clampInt(config.PORT, 7000, 1, 65_535);
  const app = createApp({ config });
  app.listen(port, '0.0.0.0', () => console.log(`[providers-api] listening on ${port}; modules=${listProviders(config).length}`));
}

module.exports = { CONFIG_PATH, loadConfig, createApp, listProviders, displayName, validatePayload, mapStreams };
