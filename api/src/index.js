// The site, behind one shared password, plus the content store for its
// editable sections (WORK, ABOUT, CONTACT) and WORK's images and video.
//
// A deliberately small, provisional setup. The Worker runs before every static
// asset (run_worker_first), so nothing is served without a session:
//
//   no session, GET      → the login page (401)
//   POST /login          → right password: session cookie + 303 back to `next`
//   GET  /logout         → clears the cookie, back to the login page
//   no session, other    → 401 JSON
//
// With a session:
//
//   GET /sections        → 200 { work, about, contact }: html | null each
//   PUT /sections/:name  → 204; body { html }. An empty html deletes the
//                          override, so the page falls back to its own copy.
//   GET    /media        → 200 [{ id, kind, name }], oldest first
//   POST   /media        → 201 { id, kind, name }; body is the file itself,
//                          Content-Type image/* or video/*, name in X-File-Name
//   GET    /media/:id    → the file (Range-aware, so video can seek)
//   DELETE /media/:id    → 204
//   anything else        → the static site (ASSETS)
//
// Sessions are stateless: the cookie is an HMAC of a fixed label keyed by
// SITE_PASSWORD, so changing the password signs everyone out. The cookie is
// SameSite=Lax and the API sends no CORS headers, so other sites can neither
// ride a visitor's session nor read the content.
//
// The page cleans section HTML both before saving and after loading, so this
// Worker only checks the shape of a write (known section, string body, bounded
// size), never its markup.
//
// Media lives in R2 (MEDIA), one object per file. The R2 listing is the list:
// keys begin with a base-36 timestamp, so listing order is upload order, and
// the original name rides along as custom metadata. No separate index to keep
// in step.

const SECTIONS = ['work', 'about', 'contact'];
const MAX_HTML_BYTES = 64 * 1024;
const COOKIE = 'lnamazi_session';
const SESSION_DAYS = 30;
const SESSION_LABEL = 'lnamazi-session-v1';

function json(status, body) {
  const headers = { 'Cache-Control': 'no-store' };
  if (body === undefined) return new Response(null, { status, headers });
  headers['Content-Type'] = 'application/json';
  return new Response(JSON.stringify(body), { status, headers });
}

// ── Sessions ──────────────────────────────────────────────────────────────────

// Constant-time for equal lengths, so a secret can't be guessed byte by byte.
function sameString(given, expected) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sessionToken(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(SESSION_LABEL));
  return [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function cookieValue(request, name) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function signedIn(request, env) {
  if (!env.SITE_PASSWORD) return false;   // no secret set: nobody gets in
  const given = cookieValue(request, COOKIE);
  return given !== null && sameString(given, await sessionToken(env.SITE_PASSWORD));
}

// Only same-site paths, so the login form can't be used as an open redirect.
function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
    ? next : '/';
}

// ── Login page ────────────────────────────────────────────────────────────────

const escapeAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Inline and self-contained: it is served before any asset is allowed through.
// Colours are the site's opening palette (Ultramarine Flat).
function loginPage(next, failed) {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg: #0c168f; --surface: #101fa4; --text: #eccb84; --dim: #cbb684; --rule: #b9a06a; }
    body {
      min-height: 100vh; min-height: 100dvh;
      display: flex; align-items: center; justify-content: center;
      padding: 16px;
      font-family: system-ui, sans-serif;
      background: var(--bg); color: var(--text);
    }
    form { width: 100%; max-width: 18rem; display: flex; flex-direction: column; gap: 0.9rem; }
    label { font-size: 0.72rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--dim); }
    input, button {
      font: inherit; font-size: 1rem; color: var(--text);
      background: var(--surface); border: 1px solid var(--rule);
      padding: 0.65rem 0.8rem;
    }
    input:focus-visible, button:focus-visible { outline: 1px solid var(--text); outline-offset: 2px; }
    button { cursor: pointer; letter-spacing: 0.12em; text-transform: uppercase; font-size: 0.8rem; }
    button:hover { border-color: var(--text); }
    .error { font-size: 0.8rem; color: var(--text); }
  </style>
</head>
<body>
  <form method="post" action="/login">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <input type="hidden" name="next" value="${escapeAttr(next)}">
    ${failed ? '<p class="error" role="alert">That password isn’t right.</p>' : ''}
    <button type="submit">Enter</button>
  </form>
</body>
</html>`, {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function login(request, env, url) {
  const form = await request.formData().catch(() => null);
  const password = form?.get('password');
  const next = safeNext(form?.get('next'));
  if (!env.SITE_PASSWORD || typeof password !== 'string' ||
      !sameString(password, env.SITE_PASSWORD)) {
    return loginPage(next, true);
  }
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return new Response(null, {
    status: 303,
    headers: {
      'Location': next,
      'Cache-Control': 'no-store',
      'Set-Cookie': `${COOKIE}=${await sessionToken(env.SITE_PASSWORD)}; Path=/; ` +
                    `Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}

function logout() {
  return new Response(null, {
    status: 303,
    headers: {
      'Location': '/',
      'Cache-Control': 'no-store',
      'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    },
  });
}

// ── Sections ──────────────────────────────────────────────────────────────────

async function readSections(env) {
  const values = await Promise.all(SECTIONS.map(name => env.CONTENT.get(name)));
  return json(200, Object.fromEntries(SECTIONS.map((name, i) => [name, values[i]])));
}

async function writeSection(request, env, name) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  if (typeof body?.html !== 'string') return json(400, { error: 'html must be a string' });
  const html = body.html.trim();
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    return json(413, { error: 'html too large' });
  }
  if (html) await env.CONTENT.put(name, html);
  else await env.CONTENT.delete(name);
  return json(204);
}

function sectionsApi(request, env, path) {
  if (path === '/sections') {
    return request.method === 'GET' ? readSections(env) : json(405, { error: 'method not allowed' });
  }
  const name = path.slice('/sections/'.length);
  if (!SECTIONS.includes(name)) return json(404, { error: 'not found' });
  return request.method === 'PUT' ? writeSection(request, env, name) : json(405, { error: 'method not allowed' });
}

// ── Media ─────────────────────────────────────────────────────────────────────

// Just under the Workers request-body limit (100 MB on the Free plan).
const MAX_MEDIA_BYTES = 95 * 1024 * 1024;
const MEDIA_PREFIX = 'media/';
const MEDIA_ID = /^[0-9a-z]{9}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mediaKind = type => /^(image|video)\//.exec(type ?? '')?.[1] ?? null;

function mediaItem(object) {
  return {
    id: object.key.slice(MEDIA_PREFIX.length),
    kind: mediaKind(object.httpMetadata?.contentType),
    name: object.customMetadata?.name ?? '',
  };
}

async function listMedia(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.MEDIA.list({ prefix: MEDIA_PREFIX, cursor, include: ['httpMetadata', 'customMetadata'] });
    items.push(...page.objects.map(mediaItem));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json(200, items);
}

async function uploadMedia(request, env) {
  const type = request.headers.get('Content-Type') ?? '';
  if (!mediaKind(type)) return json(415, { error: 'only images and video' });
  const length = Number(request.headers.get('Content-Length'));
  if (!(length > 0)) return json(411, { error: 'Content-Length required' });
  if (length > MAX_MEDIA_BYTES) return json(413, { error: 'file too large' });
  let name = '';
  try {
    name = decodeURIComponent(request.headers.get('X-File-Name') ?? '').slice(0, 200);
  } catch {}
  const id = `${Date.now().toString(36).padStart(9, '0')}-${crypto.randomUUID()}`;
  const object = await env.MEDIA.put(MEDIA_PREFIX + id, request.body, {
    httpMetadata: { contentType: type },
    customMetadata: { name },
  });
  return json(201, mediaItem(object));
}

async function serveMedia(request, env, id) {
  const object = await env.MEDIA.get(MEDIA_PREFIX + id, { range: request.headers });
  if (!object) return json(404, { error: 'not found' });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  // Private: every response is behind the password. Immutable: an id is never
  // reused for different bytes.
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  const range = object.range;
  if (range && request.headers.has('Range')) {
    const start = range.offset ?? object.size - range.suffix;
    const length = range.length ?? object.size - start;
    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

async function mediaApi(request, env, path) {
  if (path === '/media') {
    if (request.method === 'GET') return listMedia(env);
    if (request.method === 'POST') return uploadMedia(request, env);
    return json(405, { error: 'method not allowed' });
  }
  const id = path.slice('/media/'.length);
  if (!MEDIA_ID.test(id)) return json(404, { error: 'not found' });
  if (request.method === 'GET' || request.method === 'HEAD') return serveMedia(request, env, id);
  if (request.method === 'DELETE') {
    await env.MEDIA.delete(MEDIA_PREFIX + id);
    return json(204);
  }
  return json(405, { error: 'method not allowed' });
}

// ── Routing ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/(.)\/+$/, '$1');

    if (path === '/login' && request.method === 'POST') return login(request, env, url);
    if (path === '/logout') return logout();

    if (!(await signedIn(request, env))) {
      return request.method === 'GET' || request.method === 'HEAD'
        ? loginPage(url.pathname + url.search, false)
        : json(401, { error: 'unauthorized' });
    }

    if (path === '/sections' || path.startsWith('/sections/')) return sectionsApi(request, env, path);
    if (path === '/media' || path.startsWith('/media/')) return mediaApi(request, env, path);
    return env.ASSETS.fetch(request);
  },
};
