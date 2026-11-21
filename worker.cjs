'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS_DIR = path.join(__dirname, 'providers');
const MAX_INPUT_BYTES = 12 * 1024;

function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) {
        reject(new Error('input_too_large'));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid_json')); }
    });
    process.stdin.on('error', () => reject(new Error('input_error')));
  });
}

async function main() {
  // Provider modules may log diagnostics; keep stdout reserved for the result protocol.
  console.log = console.info = console.warn = console.error = () => {};
  try {
    const input = await readInput();
    const providerId = String(input.providerId || '');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerId)) throw new Error('invalid_provider');
    const file = path.join(PROVIDERS_DIR, `${providerId}.js`);
    if (!fs.existsSync(file) || path.dirname(file) !== PROVIDERS_DIR) throw new Error('provider_not_found');

    // Configuration is delivered by the parent process over stdin, never from an env file.
    globalThis.TMDB_API_KEY = String(input.tmdbApiKey ?? '');
    globalThis.PROVIDER_SOURCE_TIMEOUT_MS = Number(input.providerSourceTimeoutMs);
    globalThis.DIRECT_PROVIDER_API_TIMEOUT_MS = Number(input.directProviderApiTimeoutMs);

    const provider = require(file);
    if (typeof provider.getStreams !== 'function') throw new Error('provider_unsupported');
    const result = await provider.getStreams(
      String(input.tmdbId),
      String(input.mediaType),
      input.season == null ? null : Number(input.season),
      input.episode == null ? null : Number(input.episode)
    );
    process.stdout.write(JSON.stringify({ ok: true, streams: Array.isArray(result) ? result.slice(0, 100) : [] }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, streams: [], error: String(error?.message || 'provider_error').slice(0, 120) }));
    process.exitCode = 1;
  }
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ ok: false, streams: [], error: 'worker_error' }));
  process.exitCode = 1;
});
