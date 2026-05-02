// Cloudflare Worker entry: serves static assets and proxies /api/phone-llm/chat
// to a phone-hosted llama.cpp server. The real API key never leaves the server.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const MAX_MESSAGE_CHARS = 1000;
const MAX_HISTORY = 8;
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_TOKENS = 180;
const TEMPERATURE = 0.4;
const DEFAULT_MODEL = 'llama-3.2-3b-instruct.q4km.gguf';

const SYSTEM_PROMPT =
  "You are Jozo's portfolio assistant. You are a small local LLM running on " +
  "Jozo's Android phone as a side project. Answer clearly, briefly, and naturally. " +
  "Do not pretend to be a large cloud model. If asked about Jozo, only mention " +
  "information provided by the website or the current conversation. Do not output " +
  "JSON unless explicitly asked.";

const rateBuckets = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (bucket.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] >= RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k);
    }
  }
  return true;
}

const RADAR_REPO = 'mestrovicjozo/daily-ai-radar';
const RADAR_CACHE_TTL = 600; // 10 min

async function radarList() {
  const cache = caches.default;
  const cacheKey = new Request('https://radar.cache/list');
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let res;
  try {
    res = await fetch(
      `https://api.github.com/repos/${RADAR_REPO}/contents/digests`,
      {
        headers: {
          'user-agent': 'jozobozo.org-cv/1.0',
          'accept': 'application/vnd.github+json'
        }
      }
    );
  } catch (err) {
    console.error('radar list fetch failed', err);
    return json({ error: 'Could not load issue list.' }, 502);
  }
  if (!res.ok) {
    console.error('radar list non-ok', res.status);
    return json({ error: 'Could not load issue list.' }, 502);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return json({ error: 'Could not parse issue list.' }, 502);
  }

  const dates = (Array.isArray(data) ? data : [])
    .filter(f => f && typeof f.name === 'string' && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
    .map(f => f.name.replace(/\.md$/, ''))
    .sort()
    .reverse();

  const response = json({ dates });
  response.headers.set('cache-control', `public, max-age=${RADAR_CACHE_TTL}`);
  await cache.put(cacheKey, response.clone());
  return response;
}

async function radarDigest(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'Invalid date.' }, 400);
  }
  const cache = caches.default;
  const cacheKey = new Request(`https://radar.cache/digest/${date}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let res;
  try {
    res = await fetch(
      `https://raw.githubusercontent.com/${RADAR_REPO}/main/digests/${date}.md`,
      { headers: { 'user-agent': 'jozobozo.org-cv/1.0' } }
    );
  } catch (err) {
    console.error('radar digest fetch failed', err);
    return json({ error: 'Could not load issue.' }, 502);
  }
  if (res.status === 404) {
    return json({ error: 'No issue for that date.' }, 404);
  }
  if (!res.ok) {
    console.error('radar digest non-ok', res.status);
    return json({ error: 'Could not load issue.' }, 502);
  }

  const content = await res.text();
  const response = json({ date, content });
  response.headers.set('cache-control', `public, max-age=${RADAR_CACHE_TTL}`);
  await cache.put(cacheKey, response.clone());
  return response;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

async function handleChat(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { 'allow': 'POST' } });
  }

  if (!env.PHONE_LLM_BASE_URL || !env.PHONE_LLM_API_KEY) {
    console.error('phone-llm: missing PHONE_LLM_BASE_URL or PHONE_LLM_API_KEY');
    return json({ error: 'The chat service is not configured yet.' }, 503);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!checkRateLimit(ip)) {
    return json({ error: "You're going a bit fast. Try again in a minute." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }

  const incoming = Array.isArray(body?.messages) ? body.messages : null;
  if (!incoming || incoming.length === 0) {
    return json({ error: 'No messages provided.' }, 400);
  }

  const cleaned = [];
  for (const m of incoming.slice(-MAX_HISTORY)) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = m.content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!content) continue;
    cleaned.push({ role: m.role, content });
  }
  if (cleaned.length === 0 || cleaned[cleaned.length - 1].role !== 'user') {
    return json({ error: 'The last message must come from the user.' }, 400);
  }

  const payload = {
    model: env.PHONE_LLM_MODEL || DEFAULT_MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...cleaned],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(`${env.PHONE_LLM_BASE_URL.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${env.PHONE_LLM_API_KEY}`
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      return json({ error: 'The phone took too long to respond.' }, 504);
    }
    console.error('phone-llm: upstream fetch failed', err);
    return json({ error: 'My phone-hosted LLM is currently offline. Try again later.' }, 502);
  }
  clearTimeout(timer);

  if (upstream.status === 401 || upstream.status === 403) {
    const txt = await upstream.text().catch(() => '');
    console.error('phone-llm: upstream auth failure', upstream.status, txt.slice(0, 500));
    return json({ error: 'Server authentication to the LLM failed.' }, 502);
  }
  if (upstream.status === 502 || upstream.status === 503 || upstream.status === 504) {
    const txt = await upstream.text().catch(() => '');
    console.error('phone-llm: upstream gateway error', upstream.status, txt.slice(0, 500));
    return json({ error: 'The phone LLM is offline or unreachable.' }, 502);
  }
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    console.error('phone-llm: upstream error', upstream.status, txt.slice(0, 500));
    return json({ error: 'Something went wrong talking to the phone.' }, 502);
  }

  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    console.error('phone-llm: upstream JSON parse failed', err);
    return json({ error: 'Unexpected response from the phone.' }, 502);
  }

  const reply = data?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    console.error('phone-llm: upstream returned no content', JSON.stringify(data).slice(0, 500));
    return json({ error: 'The phone returned an empty reply.' }, 502);
  }

  return json({ reply: reply.trim() });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/phone-llm/chat') {
      return handleChat(request, env);
    }
    if (url.pathname === '/api/radar/list') {
      return radarList();
    }
    const digestMatch = url.pathname.match(/^\/api\/radar\/digest\/([^/]+)$/);
    if (digestMatch) {
      return radarDigest(decodeURIComponent(digestMatch[1]));
    }
    return env.ASSETS.fetch(request);
  }
};
