// Serves the static site, plus one small API for the S2R status message.
//
//   GET    /api/s2r-message   -> {"text": "...", "updated": "ISO time" | null}
//   PUT    /api/s2r-message   -> set it; body is plain text or {"text": "..."}
//   DELETE /api/s2r-message   -> clear it
//
// PUT and DELETE need "Authorization: Bearer <STATUS_TOKEN>", a Worker secret.
// The message can also be edited by hand in the Cloudflare dashboard (KV
// namespace jjrpf-com-status, key s2r-message); that just has no timestamp.

const PATH = '/api/s2r-message';
const KEY = 's2r-message';
const MAX = 280;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  },
});

async function authorized(request, env) {
  if (!env.STATUS_TOKEN) return false;
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = new TextEncoder().encode(got), b = new TextEncoder().encode(env.STATUS_TOKEN);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function readText(request) {
  const raw = await request.text();
  if ((request.headers.get('content-type') || '').includes('json')) {
    try { const j = JSON.parse(raw); return typeof j.text === 'string' ? j.text : ''; } catch { return null; }
  }
  return raw;
}

async function message(request, env) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const { value, metadata } = await env.STATUS.getWithMetadata(KEY);
    const text = (value || '').trim();
    return json({ text: text || null, updated: text && metadata ? metadata.updated || null : null });
  }
  if (request.method !== 'PUT' && request.method !== 'POST' && request.method !== 'DELETE') {
    return json({ error: 'Use GET, PUT or DELETE.' }, 405);
  }
  if (!env.STATUS_TOKEN) return json({ error: 'STATUS_TOKEN is not set on the Worker.' }, 503);
  if (!(await authorized(request, env))) return json({ error: 'Bad or missing token.' }, 401);

  const text = request.method === 'DELETE' ? '' : await readText(request);
  if (text === null) return json({ error: 'Body is not valid JSON.' }, 400);
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length > MAX) return json({ error: `Keep it to ${MAX} characters.` }, 400);
  if (!clean) {
    await env.STATUS.delete(KEY);
    return json({ text: null, updated: null });
  }
  const updated = new Date().toISOString();
  await env.STATUS.put(KEY, clean, { metadata: { updated } });
  return json({ text: clean, updated });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === PATH) return message(request, env);
    return env.ASSETS.fetch(request);
  },
};
