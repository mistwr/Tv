// api/verify.js — Stream Health Checker
// Checks if an HLS/M3U8/MP4 stream URL is alive using HEAD requests
// Called from frontend in batches — no API key needed

export const config = { maxDuration: 10 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const UA = 'Mozilla/5.0 (SmartTV; Linux) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, batch } = req.query;

  // ── Batch mode: verify multiple URLs at once ─────────────────────────────
  if (batch) {
    let urls;
    try { urls = JSON.parse(decodeURIComponent(batch)); }
    catch { return res.status(400).json({ error: 'Invalid batch JSON' }); }

    if (!Array.isArray(urls) || urls.length > 50) {
      return res.status(400).json({ error: 'batch must be array of max 50 URLs' });
    }

    const results = await Promise.all(urls.map(u => checkUrl(u)));
    return res.status(200).json({ results });
  }

  // ── Single URL mode ───────────────────────────────────────────────────────
  if (!url) return res.status(400).json({ error: 'Missing ?url= or ?batch=' });

  let targetUrl;
  try {
    targetUrl = decodeURIComponent(url);
    new URL(targetUrl); // validate
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const result = await checkUrl(targetUrl);
  return res.status(200).json(result);
}

async function checkUrl(targetUrl) {
  const start = Date.now();
  try {
    new URL(targetUrl); // validate
  } catch {
    return { url: targetUrl, ok: false, status: 0, ms: 0, reason: 'invalid_url' };
  }

  // Block private networks
  const host = new URL(targetUrl).hostname;
  if (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
    return { url: targetUrl, ok: false, status: 0, ms: 0, reason: 'private_network' };
  }

  try {
    // Try HEAD first (fast, no body download)
    let r = await fetch(targetUrl, {
      method: 'HEAD',
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Origin': 'https://mypoupar.com',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
    });

    const ms = Date.now() - start;

    // Some servers reject HEAD but accept GET — retry with GET + range
    if (r.status === 405 || r.status === 403) {
      r = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Accept': '*/*',
          'Range': 'bytes=0-1023',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
    }

    const ms2 = Date.now() - start;
    const ok = r.status >= 200 && r.status < 400;
    const ct = r.headers.get('content-type') || '';

    return {
      url: targetUrl,
      ok,
      status: r.status,
      ms: ms2,
      // Extra hint: is it actually a video stream?
      isStream: ok && (
        ct.includes('mpegurl') ||
        ct.includes('video') ||
        ct.includes('octet-stream') ||
        targetUrl.includes('.m3u') ||
        targetUrl.includes('.m3u8') ||
        targetUrl.includes('.ts')
      ),
    };
  } catch (e) {
    return {
      url: targetUrl,
      ok: false,
      status: 0,
      ms: Date.now() - start,
      reason: e.name === 'TimeoutError' ? 'timeout' : 'network_error',
    };
  }
}
