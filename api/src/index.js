// Content store for the site's editable sections (ABOUT, CONTACT).
//
// A deliberately small, provisional backend: one KV key per section, holding
// the section body as HTML. Anyone may read; writing needs the EDIT_KEY secret
// as a bearer token. The page cleans the HTML both before saving and after
// loading, so this Worker only checks the shape of a write (known section,
// string body, bounded size), never its markup.
//
//   GET /sections          → 200 { about: html | null, contact: html | null }
//   PUT /sections/:name    → 204; body { html }. An empty html deletes the
//                            override, so the page falls back to its own copy.

const SECTIONS = ['about', 'contact'];
const MAX_HTML_BYTES = 64 * 1024;

// Bearer-token auth rather than cookies, so CORS is not the security boundary
// and any origin (the live site, a local preview) may call in.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function respond(status, body) {
  const headers = { ...CORS, 'Cache-Control': 'no-store' };
  if (body === undefined) return new Response(null, { status, headers });
  headers['Content-Type'] = 'application/json';
  return new Response(JSON.stringify(body), { status, headers });
}

// Constant-time for equal lengths, so the key can't be guessed byte by byte.
function sameKey(given, expected) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function authorized(request, env) {
  if (!env.EDIT_KEY) return false;   // no secret set: nobody can write
  const header = request.headers.get('Authorization') ?? '';
  return sameKey(header, `Bearer ${env.EDIT_KEY}`);
}

async function readSections(env) {
  const values = await Promise.all(SECTIONS.map(name => env.CONTENT.get(name)));
  return Object.fromEntries(SECTIONS.map((name, i) => [name, values[i]]));
}

async function writeSection(request, env, name) {
  if (!authorized(request, env)) return respond(401, { error: 'unauthorized' });
  let body;
  try {
    body = await request.json();
  } catch {
    return respond(400, { error: 'body must be JSON' });
  }
  if (typeof body?.html !== 'string') return respond(400, { error: 'html must be a string' });
  const html = body.html.trim();
  if (new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
    return respond(413, { error: 'html too large' });
  }
  if (html) await env.CONTENT.put(name, html);
  else await env.CONTENT.delete(name);
  return respond(204);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return respond(204);
    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    if (path === '/sections') {
      if (request.method !== 'GET') return respond(405, { error: 'method not allowed' });
      return respond(200, await readSections(env));
    }

    const match = path.match(/^\/sections\/([a-z]+)$/);
    if (match && SECTIONS.includes(match[1])) {
      if (request.method !== 'PUT') return respond(405, { error: 'method not allowed' });
      return writeSection(request, env, match[1]);
    }

    return respond(404, { error: 'not found' });
  },
};
