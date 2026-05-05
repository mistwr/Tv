// api/proxy.js — MYPOUPAR TV · Smart Universal Streaming Proxy
// Handles: HLS (.m3u8), DASH (.mpd), TS segments, encryption keys, subtitles, images
// Features:
//   - Multi-UA rotation (SmartTV, Android, Desktop, iOS)
//   - 403/401 auto-retry with different Referer/Origin spoofing
//   - Full redirect chain following (302/301/307/308)
//   - M3U8 manifest URL rewriting (all segment/key/sub URLs → through this proxy)
//   - DASH/MPD manifest URL rewriting
//   - Live TS segment streaming (no full buffer, piped)
//   - Correct cache headers per content type
//   - Range request forwarding (for seeking)
//   - Private network blocking

export const config = { maxDuration: 30 };

// ── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Accept-Ranges',
};

// ── User-Agent pool — rotate to bypass server-side filtering ─────────────────
const UA_POOL = [
  // Smart TV / IPTV players
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1',
  'Mozilla/5.0 (Linux; Android 9; SmartTV Build/PPR2.181005.003) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.104 Safari/537.36',
  // Android / IPTV apps
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36',
  'Dalvik/2.1.0 (Linux; U; Android 11; SM-G991B Build/RP1A.200720.012)',
  // Desktop Chrome
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // iOS Safari (for AirPlay-friendly servers)
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  // VLC media player
  'VLC/3.0.18 LibVLC/3.0.18',
];

function pickUA(url) {
  // Choose UA based on domain hints for better compatibility
  const h = new URL(url).hostname;
  if (h.includes('samsung') || h.includes('tizen')) return UA_POOL[0];
  if (h.includes('android') || h.includes('dalvik')) return UA_POOL[3];
  if (h.includes('apple') || h.includes('akamai')) return UA_POOL[5];
  // Rotate deterministically so same URL always gets same UA (better caching)
  return UA_POOL[Math.abs(h.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % UA_POOL.length];
}

// ── Content type detection ────────────────────────────────────────────────────
function contentKind(url, ct) {
  const u = url.toLowerCase().split('?')[0];
  const c = (ct || '').toLowerCase();

  if (u.endsWith('.m3u') || u.endsWith('.m3u8') ||
      c.includes('mpegurl') || c.includes('x-mpegurl') || c.includes('vnd.apple'))
    return 'm3u8';

  if (u.endsWith('.mpd') || c.includes('dash+xml'))
    return 'mpd';

  if (u.endsWith('.ts') || u.endsWith('.aac') || u.endsWith('.mp2t') ||
      c.includes('video/') || c.includes('audio/') || c.includes('octet-stream'))
    return 'segment';

  if (u.endsWith('.key') || u.includes('/key') || u.includes('encryption'))
    return 'key';

  if (u.endsWith('.vtt') || u.endsWith('.srt') || u.endsWith('.ttml') ||
      c.includes('vtt') || c.includes('text/plain'))
    return 'subtitle';

  // Likely M3U8 even without extension (many live streams have no extension)
  if (c.includes('text/plain') || c.includes('text/html'))
    return 'm3u8';

  return 'binary';
}

// ── URL resolution ────────────────────────────────────────────────────────────
function resolveUrl(base, rel) {
  if (!rel || rel.startsWith('data:')) return rel;
  if (rel.startsWith('http://') || rel.startsWith('https://')) return rel;
  if (rel.startsWith('//')) return 'https:' + rel;
  try { return new URL(rel, base).href; } catch { return rel; }
}

function makeProxyUrl(host, proto, target) {
  return `${proto}://${host}/api/proxy?url=${encodeURIComponent(target)}`;
}

// ── M3U8 rewriter — rewrites ALL URLs inside manifest ────────────────────────
function rewriteM3U8(text, sourceUrl, host, proto) {
  const lines = text.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trim = line.trim();
    if (!trim) { out.push(line); continue; }

    // #EXT-X-KEY URI="..." — encryption key URL
    // #EXT-X-MAP URI="..." — init segment
    // #EXT-X-MEDIA URI="..." — alternate rendition
    line = line.replace(/URI="([^"]+)"/g, (_, uri) =>
      `URI="${makeProxyUrl(host, proto, resolveUrl(sourceUrl, uri))}"`
    );

    // Sub-playlist or segment URLs — lines not starting with #
    if (trim && !trim.startsWith('#')) {
      const abs = resolveUrl(sourceUrl, trim);
      out.push(makeProxyUrl(host, proto, abs));
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

// ── DASH/MPD rewriter — rewrites BaseURL and SegmentTemplate ─────────────────
function rewriteMPD(text, sourceUrl, host, proto) {
  // Rewrite BaseURL elements
  text = text.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (_, u) =>
    `<BaseURL>${makeProxyUrl(host, proto, resolveUrl(sourceUrl, u))}</BaseURL>`
  );
  // Rewrite initialization and media URL patterns (just proxy the base path)
  text = text.replace(/\binitialization="([^"]+)"/g, (_, u) =>
    `initialization="${makeProxyUrl(host, proto, resolveUrl(sourceUrl, u))}"`
  );
  text = text.replace(/\bmedia="([^"]+)"/g, (_, u) =>
    `media="${makeProxyUrl(host, proto, resolveUrl(sourceUrl, u))}"`
  );
  return text;
}

// ── Fetch with retry (different UA/headers on 403/401) ───────────────────────
async function fetchWithRetry(targetUrl, extraHeaders = {}) {
  const parsed = new URL(targetUrl);
  const origin = parsed.origin;
  const referers = [
    origin + '/',
    'https://www.google.com/',
    'https://duckduckgo.com/',
    '',  // no referer
  ];

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ua = attempt === 0 ? pickUA(targetUrl) : UA_POOL[attempt % UA_POOL.length];
    const headers = {
      'User-Agent': ua,
      'Accept': '*/*',
      'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      ...extraHeaders,
    };

    // Add Origin/Referer on first attempt; rotate on retries
    if (attempt < referers.length) {
      headers['Referer'] = referers[attempt];
      if (attempt === 0) headers['Origin'] = origin;
    }

    try {
      const r = await fetch(targetUrl, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });

      // Success or definitive failure (404, 410 etc) — don't retry
      if (r.ok || (r.status >= 400 && r.status !== 403 && r.status !== 401 && r.status !== 429)) {
        return { response: r, attempt };
      }

      // 429 Too Many Requests — small pause before retry
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
      }

      lastError = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastError = e;
      if (e.name === 'TimeoutError') break; // no point retrying a timeout
    }
  }

  throw lastError || new Error('All attempts failed');
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'GET/HEAD only' });
  }

  // Parse & validate target URL
  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: 'Missing ?url=' });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(raw);
    if (!targetUrl.startsWith('http')) throw new Error('Not http');
    new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Block private networks
  const host = new URL(targetUrl).hostname;
  if (/^(localhost|127\.|0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(host)) {
    return res.status(403).json({ error: 'Private network blocked' });
  }

  // Forward Range header (video seeking)
  const extraHeaders = {};
  if (req.headers['range']) extraHeaders['Range'] = req.headers['range'];

  try {
    const { response: upstream, attempt } = await fetchWithRetry(targetUrl, extraHeaders);

    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const kind = contentKind(targetUrl, ct);

    const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'https';
    const proxyHost = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';

    // Log retries for monitoring
    if (attempt > 0) console.log(`[proxy] ${targetUrl} needed ${attempt+1} attempts`);

    // ── M3U8 playlist — parse text, rewrite all URLs ──────────────────────
    if (kind === 'm3u8') {
      const text = await upstream.text();
      const rewritten = rewriteM3U8(text, targetUrl, proxyHost, proto);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(upstream.status).send(rewritten);
    }

    // ── DASH/MPD manifest ──────────────────────────────────────────────────
    if (kind === 'mpd') {
      const text = await upstream.text();
      const rewritten = rewriteMPD(text, targetUrl, proxyHost, proto);
      res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.status(upstream.status).send(rewritten);
    }

    // ── Subtitle/VTT files ─────────────────────────────────────────────────
    if (kind === 'subtitle') {
      const text = await upstream.text();
      res.setHeader('Content-Type', ct || 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(upstream.status).send(text);
    }

    // ── Encryption keys — tiny, load fully ────────────────────────────────
    if (kind === 'key') {
      const buf = await upstream.arrayBuffer();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (upstream.headers.get('content-length'))
        res.setHeader('Content-Length', upstream.headers.get('content-length'));
      return res.status(upstream.status).send(Buffer.from(buf));
    }

    // ── Video/Audio segments and binaries — stream directly ───────────────
    // Forward useful headers
    const fwdHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    fwdHeaders.forEach(h => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h.replace(/-./g, m => m[1].toUpperCase().replace('-', '')).replace(/^./, c => c.toUpperCase()).replace(/([A-Z])/g, m => '-' + m), v);
    });
    // Correct header casing
    if (upstream.headers.get('content-type')) res.setHeader('Content-Type', upstream.headers.get('content-type'));
    if (upstream.headers.get('content-length')) res.setHeader('Content-Length', upstream.headers.get('content-length'));
    if (upstream.headers.get('content-range')) res.setHeader('Content-Range', upstream.headers.get('content-range'));
    if (upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges'));

    // Live segments: no-cache; VOD segments: short cache
    const isLive = targetUrl.includes('live') || targetUrl.includes('stream') ||
                   !upstream.headers.get('content-length');
    res.setHeader('Cache-Control', isLive ? 'no-cache' : 'public, max-age=30');

    res.status(upstream.status);

    // Stream the body directly without buffering the whole segment
    if (upstream.body) {
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }

    // Fallback: buffer (for environments where streaming isn't available)
    const buf = await upstream.arrayBuffer();
    return res.send(Buffer.from(buf));

  } catch (err) {
    console.error('[proxy] FAILED', targetUrl, '—', err.message);
    return res.status(502).json({
      error: 'Stream unreachable',
      reason: err.message,
      url: targetUrl,
    });
  }
}
