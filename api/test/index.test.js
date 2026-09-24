import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// An in-memory stand-in for the KV binding: just the calls the Worker makes.
function fakeEnv(key = 'secret') {
  const store = new Map();
  return {
    EDIT_KEY: key,
    store,
    CONTENT: {
      get: async name => store.get(name) ?? null,
      put: async (name, value) => { store.set(name, value); },
      delete: async name => { store.delete(name); },
    },
  };
}

const call = (env, method, path, { auth, body } = {}) => worker.fetch(
  new Request(`https://content.example${path}`, {
    method,
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
  env,
);

test('GET /sections returns every section, null when unset', async () => {
  const env = fakeEnv();
  env.store.set('about', '<p>Hi</p>');
  const res = await call(env, 'GET', '/sections');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await res.json(), { about: '<p>Hi</p>', contact: null });
});

test('PUT stores the section with the right key', async () => {
  const env = fakeEnv();
  const res = await call(env, 'PUT', '/sections/contact', { auth: 'secret', body: { html: ' <p>Mail</p> ' } });
  assert.equal(res.status, 204);
  assert.equal(env.store.get('contact'), '<p>Mail</p>');
});

test('PUT with empty html deletes the override', async () => {
  const env = fakeEnv();
  env.store.set('about', '<p>Old</p>');
  const res = await call(env, 'PUT', '/sections/about', { auth: 'secret', body: { html: '  ' } });
  assert.equal(res.status, 204);
  assert.equal(env.store.has('about'), false);
});

test('PUT is refused without the right key, or when no key is configured', async () => {
  for (const [env, auth] of [[fakeEnv(), undefined], [fakeEnv(), 'wrong'], [fakeEnv(''), '']]) {
    const res = await call(env, 'PUT', '/sections/about', { auth, body: { html: '<p>x</p>' } });
    assert.equal(res.status, 401);
    assert.equal(env.store.size, 0);
  }
});

test('PUT rejects malformed and oversized bodies', async () => {
  const env = fakeEnv();
  assert.equal((await call(env, 'PUT', '/sections/about', { auth: 'secret', body: { html: 3 } })).status, 400);
  const big = '<p>' + 'x'.repeat(70 * 1024) + '</p>';
  assert.equal((await call(env, 'PUT', '/sections/about', { auth: 'secret', body: { html: big } })).status, 413);
  assert.equal(env.store.size, 0);
});

test('unknown sections and methods are refused', async () => {
  const env = fakeEnv();
  assert.equal((await call(env, 'PUT', '/sections/work', { auth: 'secret', body: { html: 'x' } })).status, 404);
  assert.equal((await call(env, 'POST', '/sections')).status, 405);
  assert.equal((await call(env, 'GET', '/sections/about')).status, 405);
  assert.equal((await call(env, 'OPTIONS', '/sections/about')).status, 204);
});
