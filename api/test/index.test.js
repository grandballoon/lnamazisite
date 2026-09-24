import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ORIGIN = 'https://site.example';

// In-memory stand-ins for the bindings: just the calls the Worker makes.
function fakeEnv(password = 'secret') {
  const store = new Map();
  return {
    SITE_PASSWORD: password,
    store,
    CONTENT: {
      get: async name => store.get(name) ?? null,
      put: async (name, value) => { store.set(name, value); },
      delete: async name => { store.delete(name); },
    },
    ASSETS: { fetch: async req => new Response(`asset:${new URL(req.url).pathname}`) },
    MEDIA: fakeBucket(),
  };
}

// Just enough of an R2 bucket: keys sort as R2 lists them, and a Range header
// on get() is honoured as R2 does (offset/length, or a suffix).
function fakeBucket() {
  const objects = new Map();
  const record = (key, o) => ({
    key,
    size: o.bytes.length,
    httpEtag: '"etag"',
    httpMetadata: o.httpMetadata,
    customMetadata: o.customMetadata,
    writeHttpMetadata: h => h.set('Content-Type', o.httpMetadata.contentType),
  });
  return {
    objects,
    async put(key, body, { httpMetadata, customMetadata }) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, httpMetadata, customMetadata });
      return record(key, objects.get(key));
    },
    async get(key, { range } = {}) {
      const o = objects.get(key);
      if (!o) return null;
      const r = /bytes=(\d*)-(\d*)/.exec(range?.get('Range') ?? '');
      let bytes = o.bytes, objRange;
      if (r) {
        const start = r[1] ? +r[1] : o.bytes.length - +r[2];
        const end = r[1] && r[2] ? +r[2] + 1 : o.bytes.length;
        bytes = o.bytes.slice(start, end);
        objRange = r[1] ? { offset: start, length: end - start } : { suffix: +r[2] };
      }
      return { ...record(key, o), range: objRange, body: new Response(bytes).body };
    },
    async list({ prefix }) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      return { objects: keys.map(k => record(k, objects.get(k))), truncated: false };
    },
    async delete(key) { objects.delete(key); },
  };
}

const call = (env, method, path, { cookie, body, form, raw, headers: extra } = {}) => {
  const headers = { ...extra };
  if (cookie) headers.Cookie = cookie;
  let payload = raw;
  if (form) payload = new URLSearchParams(form);
  else if (body !== undefined) payload = JSON.stringify(body);
  return worker.fetch(new Request(ORIGIN + path, { method, headers, body: payload, redirect: 'manual' }), env);
};

async function signIn(env, password = 'secret', next = '/') {
  return call(env, 'POST', '/login', { form: { password, next } });
}

async function sessionCookie(env, password = 'secret') {
  const res = await signIn(env, password);
  return res.headers.get('Set-Cookie').split(';')[0];
}

test('without a session, pages get the login form and the API gets 401', async () => {
  const env = fakeEnv();
  const page = await call(env, 'GET', '/index.html?edit');
  assert.equal(page.status, 401);
  const html = await page.text();
  assert.match(html, /<form method="post" action="\/login">/);
  assert.match(html, /name="next" value="\/index.html\?edit"/);
  assert.equal((await call(env, 'PUT', '/sections/about', { body: { html: 'x' } })).status, 401);
  assert.equal(env.store.size, 0);
});

test('a forged or stale cookie is not a session', async () => {
  const env = fakeEnv();
  assert.equal((await call(env, 'GET', '/', { cookie: 'lnamazi_session=abc' })).status, 401);
  const old = await sessionCookie(fakeEnv('old-password'), 'old-password');
  assert.equal((await call(env, 'GET', '/', { cookie: old })).status, 401);
});

test('the right password sets a session and returns to `next`', async () => {
  const env = fakeEnv();
  const res = await signIn(env, 'secret', '/index.html?edit');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), '/index.html?edit');
  const cookie = res.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  const page = await call(env, 'GET', '/index.html', { cookie: cookie.split(';')[0] });
  assert.equal(await page.text(), 'asset:/index.html');
});

test('a wrong password, or none configured, is refused', async () => {
  const wrong = await signIn(fakeEnv(), 'nope');
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /isn’t right/);
  assert.equal(wrong.headers.get('Set-Cookie'), null);
  assert.equal((await signIn(fakeEnv(''), '')).status, 401);
});

test('`next` cannot send the visitor off-site', async () => {
  for (const next of ['//evil.example', 'https://evil.example', 'x']) {
    const res = await signIn(fakeEnv(), 'secret', next);
    assert.equal(res.headers.get('Location'), '/');
  }
});

test('logout clears the cookie', async () => {
  const res = await call(fakeEnv(), 'GET', '/logout');
  assert.equal(res.status, 303);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('signed in: sections read, write, and clear', async () => {
  const env = fakeEnv();
  const cookie = await sessionCookie(env);
  let res = await call(env, 'PUT', '/sections/contact', { cookie, body: { html: ' <p>Mail</p> ' } });
  assert.equal(res.status, 204);
  res = await call(env, 'GET', '/sections', { cookie });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual(await res.json(), { work: null, about: null, contact: '<p>Mail</p>' });
  assert.equal((await call(env, 'PUT', '/sections/contact', { cookie, body: { html: '  ' } })).status, 204);
  assert.equal(env.store.has('contact'), false);
});

test('signed in: malformed, oversized, unknown and wrong-method requests are refused', async () => {
  const env = fakeEnv();
  const cookie = await sessionCookie(env);
  assert.equal((await call(env, 'PUT', '/sections/about', { cookie, body: { html: 3 } })).status, 400);
  const big = '<p>' + 'x'.repeat(70 * 1024) + '</p>';
  assert.equal((await call(env, 'PUT', '/sections/about', { cookie, body: { html: big } })).status, 413);
  assert.equal((await call(env, 'PUT', '/sections/nope', { cookie, body: { html: 'x' } })).status, 404);
  assert.equal((await call(env, 'POST', '/sections', { cookie })).status, 405);
  assert.equal((await call(env, 'GET', '/sections/about', { cookie })).status, 405);
  assert.equal(env.store.size, 0);
});

const upload = (env, cookie, bytes, type, name) => call(env, 'POST', '/media', {
  cookie,
  raw: bytes,
  headers: { 'Content-Type': type, 'Content-Length': String(bytes.length), 'X-File-Name': encodeURIComponent(name) },
});

test('media: upload, list in upload order, serve, delete', async () => {
  const env = fakeEnv();
  const cookie = await sessionCookie(env);
  const first = await upload(env, cookie, new Uint8Array([1, 2, 3]), 'image/png', 'één.png');
  assert.equal(first.status, 201);
  const a = await first.json();
  assert.equal(a.kind, 'image');
  assert.equal(a.name, 'één.png');
  await new Promise(r => setTimeout(r, 2));   // a later timestamp for the second key
  const b = await (await upload(env, cookie, new Uint8Array(10).map((_, i) => i), 'video/mp4', 'clip.mp4')).json();

  const list = await (await call(env, 'GET', '/media', { cookie })).json();
  assert.deepEqual(list.map(m => m.id), [a.id, b.id]);
  assert.deepEqual(list.map(m => m.kind), ['image', 'video']);

  const file = await call(env, 'GET', `/media/${a.id}`, { cookie });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('Content-Type'), 'image/png');
  assert.match(file.headers.get('Cache-Control'), /private/);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);

  assert.equal((await call(env, 'DELETE', `/media/${a.id}`, { cookie })).status, 204);
  assert.deepEqual((await (await call(env, 'GET', '/media', { cookie })).json()).map(m => m.id), [b.id]);
  assert.equal((await call(env, 'GET', `/media/${a.id}`, { cookie })).status, 404);
});

test('media: ranges are served as 206 so video can seek', async () => {
  const env = fakeEnv();
  const cookie = await sessionCookie(env);
  const { id } = await (await upload(env, cookie, new Uint8Array(10).map((_, i) => i), 'video/mp4', 'v.mp4')).json();
  const mid = await call(env, 'GET', `/media/${id}`, { cookie, headers: { Range: 'bytes=2-5' } });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.deepEqual([...new Uint8Array(await mid.arrayBuffer())], [2, 3, 4, 5]);
  const tail = await call(env, 'GET', `/media/${id}`, { cookie, headers: { Range: 'bytes=-3' } });
  assert.equal(tail.headers.get('Content-Range'), 'bytes 7-9/10');
});

test('media: refuses other types, missing or oversized lengths, bad ids, and no session', async () => {
  const env = fakeEnv();
  const cookie = await sessionCookie(env);
  assert.equal((await upload(env, cookie, new Uint8Array([1]), 'text/html', 'x.html')).status, 415);
  const huge = await call(env, 'POST', '/media', {
    cookie, raw: new Uint8Array([1]), headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(96 * 1024 * 1024) },
  });
  assert.equal(huge.status, 413);
  assert.equal((await call(env, 'DELETE', '/media/not-an-id', { cookie })).status, 404);
  assert.equal((await upload(env, undefined, new Uint8Array([1]), 'image/png', 'x.png')).status, 401);
  assert.equal(env.MEDIA.objects.size, 0);
});
