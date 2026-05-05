// api/chat.js — LUMIN AI Gateway
// Zero API keys needed. Sources (ordered by quality):
//   1. DuckDuckGo AI Chat (duck.ai) — gpt-4o-mini / llama-3.1-70B FREE, no key
//      Reverse-engineered approach: github.com/mrgick/duck_chat
//      Go API ref: github.com/benoitpetit/duckduckGO-chat-api
//   2. Pollinations.ai — no key, openai-compat: github.com/pollinations/pollinations
//   3. Keyword offline fallback (always works)

export const config = { maxDuration: 30 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const DDG_MODELS = [
  'gpt-4o-mini',
  'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
  'mistralai/Mistral-Small-24B-Instruct-2501',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function getDDGToken() {
  const r = await fetch('https://duckduckgo.com/duckchat/v1/status', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/event-stream',
      'Origin': 'https://duckduckgo.com',
      'Referer': 'https://duckduckgo.com/',
      'x-vqd-accept': '1',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('DDG status ' + r.status);
  const vqd = r.headers.get('x-vqd-4');
  if (!vqd) throw new Error('No VQD token');
  return vqd;
}

async function chatDDG(messages, system, modelIdx) {
  const model = DDG_MODELS[modelIdx] || DDG_MODELS[0];
  const vqd = await getDDGToken();

  const ddgMsgs = system
    ? [{ role: 'user', content: `[System: ${system}]\n\n${messages[0]?.content || ''}` }, ...messages.slice(1)]
    : messages;

  const r = await fetch('https://duckduckgo.com/duckchat/v1/chat', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
      'Origin': 'https://duckduckgo.com',
      'Referer': 'https://duckduckgo.com/',
      'x-vqd-4': vqd,
    },
    body: JSON.stringify({ model, messages: ddgMsgs }),
    signal: AbortSignal.timeout(20000),
  });

  if (!r.ok) throw new Error('DDG chat ' + r.status);

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6).trim();
      if (d === '[DONE]') continue;
      try { text += JSON.parse(d).message || ''; } catch {}
    }
  }

  if (!text.trim()) throw new Error('DDG empty response');
  return text.trim();
}

async function chatPollinations(messages, system) {
  const last = messages.at(-1)?.content || '';
  const prompt = system ? `${system}\n\n${last}` : last;
  const r = await fetch(
    `https://text.pollinations.ai/${encodeURIComponent(prompt)}?model=openai&seed=${Date.now()}`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!r.ok) throw new Error('Pollinations ' + r.status);
  const t = await r.text();
  if (!t?.trim()) throw new Error('Pollinations empty');
  return t.trim();
}

function localFallback(messages) {
  const q = (messages.at(-1)?.content || '').toLowerCase();
  if (/futebol|sport|desporto|liga|champion/.test(q)) return '⚽ Para desporto ao vivo usa o menu **Desporto** — centenas de canais verificados!';
  if (/notícia|news|jornal/.test(q)) return '📰 Vai ao menu **Notícias** para canais internacionais 24h.';
  if (/film|movie|cinema|série/.test(q)) return '🎬 No menu **Filmes** tens canais de cinema gratuitos!';
  if (/portugu|portugal|rtp|sic|tvi/.test(q)) return '🇵🇹 Vai a **🇵🇹 Portugal** no menu para canais lusos.';
  if (/music|música|rádio/.test(q)) return '🎵 No menu **Música** tens canais de música ao vivo!';
  if (/coin|poupança|mypoupar|energia|teleco/.test(q)) return '💰 Ganhas +5 MYPOUPAR Coins por minuto a ver streams. Brevemente trocáveis por descontos em energia e telecomunicações em Portugal!';
  if (/m3u|lista|playlist/.test(q)) return '📋 Em **Lista M3U Própria** podes carregar qualquer playlist M3U — iptv-org, Free-TV, ou a tua lista pessoal.';
  if (/verificar|stream|mort|offline|funciona/.test(q)) return '🔍 Usa o botão **🔍 Verificar Streams** no topo para escanear e remover canais mortos automaticamente!';
  return '📺 Sou o LUMIN AI do MYPOUPAR TV. Pergunta-me sobre canais, países, categorias ou dicas de poupança. O que queres ver?';
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const {
    messages = [],
    system = 'És o LUMIN AI, assistente do MYPOUPAR TV. Responde sempre em português de Portugal. Sê conciso e útil.',
  } = body;

  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  const errs = [];

  // 1. DuckDuckGo AI (zero keys)
  for (let i = 0; i < DDG_MODELS.length; i++) {
    try {
      const text = await chatDDG(messages, system, i);
      return res.json({ text, provider: 'duckduckgo', model: DDG_MODELS[i] });
    } catch (e) {
      errs.push(`ddg[${i}]:${e.message}`);
      if (!e.message.includes('VQD') && !e.message.includes('token') && i === 0) break;
    }
  }

  // 2. Pollinations (zero keys)
  try {
    const text = await chatPollinations(messages, system);
    return res.json({ text, provider: 'pollinations' });
  } catch (e) { errs.push('poll:' + e.message); }

  // 3. Always-on local fallback
  console.warn('[lumin] all live providers failed:', errs.join(' | '));
  return res.json({ text: localFallback(messages), provider: 'offline', errs });
}
