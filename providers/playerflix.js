'use strict';

// PlayerFlix — adapter extraído do server.js original do IracemaFlix.
// Mantém o fluxo Ajax, VIP Player, extração HLS e deduplicação do adapter original.

const PLAYERFLIX_AJAX = 'https://playerflix.ink/inc/Ajax.php';
const PLAYERFLIX_ORIGIN = 'https://playerflix.ink';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

function requestHeaders(referer) {
  return {
    accept: '*/*',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    priority: 'u=1, i',
    referer,
    'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': USER_AGENT,
    'x-requested-with': 'XMLHttpRequest'
  };
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new Error('PlayerFlix abortado');
}

function decodeEscaped(value) {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');
}

function extractM3u8(html) {
  const text = decodeEscaped(html);
  const matches = text.match(/https?:\\?\/\\?\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/gi) || [];
  return [...new Set(matches.map((value) => value.replace(/[\\"'<>),;]+$/, '')))];
}

async function readJson(url, headers, signal) {
  abortIfNeeded(signal);
  const response = await fetch(url, { headers, redirect: 'follow', signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.status !== true) return null;
  return payload;
}

async function readPlayerPage(url, referer, signal) {
  abortIfNeeded(signal);
  const response = await fetch(url, {
    headers: {
      ...requestHeaders(referer),
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      'x-requested-with': undefined
    },
    redirect: 'follow',
    signal
  });
  if (!response.ok) return { html: '', finalUrl: response.url || url };
  return { html: await response.text(), finalUrl: response.url || url };
}

async function extractVipPlayer(option, signal) {
  const match = option.embed.match(/\/video\/([a-f0-9]+)/i);
  if (!match) return [];
  const hash = match[1];
  const playerUrl = new URL(option.embed);
  const endpoint = new URL('/player/index.php', playerUrl.origin);
  endpoint.searchParams.set('data', hash);
  endpoint.searchParams.set('do', 'getVideo');
  const body = new URLSearchParams({ hash, r: '' });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...requestHeaders(option.embed),
      origin: playerUrl.origin,
      referer: option.embed,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body,
    redirect: 'follow',
    signal
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) return [];
  const url = decodeEscaped(payload.securedLink || payload.videoSource || '');
  if (!/^https?:\/\//i.test(url)) return [];
  return [{
    url,
    type: 'hls',
    label: option.label || 'VIP Player',
    quality: option.label || '',
    referer: option.embed,
    playerUrl: option.embed
  }];
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null) {
  const numericId = /^\d+$/.test(String(tmdbId)) ? String(tmdbId) : '';
  if (!numericId) return [];
  const isSeries = mediaType === 'tv' || mediaType === 'series';
  if (isSeries && (!Number.isInteger(Number(season)) || !Number.isInteger(Number(episode)))) return [];

  const pagePath = isSeries
    ? `/serie/${numericId}/${Number(season)}/${Number(episode)}`
    : `/filme/${numericId}`;
  const pageReferer = `${PLAYERFLIX_ORIGIN}${pagePath}`;
  const params = new URLSearchParams({
    type: isSeries ? 'tv' : 'movie',
    id: numericId,
    season: isSeries ? String(Number(season)) : 'null',
    episode: isSeries ? String(Number(episode)) : 'null'
  });
  const payload = await readJson(`${PLAYERFLIX_AJAX}?${params}`, requestHeaders(pageReferer));
  const options = Array.isArray(payload?.data?.options) ? payload.data.options : [];

  const streamGroups = await Promise.all(options.map((option) => withTimeout((async () => {
    if (!option?.embed || typeof option.embed !== 'string') return [];
    try {
      if (option.id === 'superflixapi' || /superflixapi\./i.test(option.embed)) return [];
      if (/\/video\/[a-f0-9]+/i.test(option.embed)) return extractVipPlayer(option);
      const page = await readPlayerPage(option.embed, pageReferer);
      return extractM3u8(page.html).slice(0, 3).map((url) => ({
        url,
        type: 'hls',
        label: option.label || option.id || 'PlayerFlix',
        quality: option.label || '',
        referer: page.finalUrl || option.embed,
        playerUrl: page.finalUrl || option.embed
      }));
    } catch {
      return [];
    }
  })(), 8000, [])));

  const streams = streamGroups.flat();
  return [...new Map(streams.map((item) => [item.url, item])).values()];
}

module.exports = { getStreams };
