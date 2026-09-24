# lnamazi-content

A provisional content store for the site's editable ABOUT and CONTACT sections: a Cloudflare Worker backed by one KV namespace.
Reads are public; writes need the `EDIT_KEY` secret as a bearer token.
The API contract is documented at the top of [src/index.js](src/index.js).

## Setup (once)

Needs Node 22 or newer; with nvm, `nvm use` picks it up from `.nvmrc`.

```sh
nvm use
npm install
npx wrangler kv namespace create CONTENT   # paste the printed id into wrangler.jsonc
npx wrangler secret put EDIT_KEY           # choose a long random key; this is the editors' password
npm run deploy                             # prints the Worker URL
```

Put the printed Worker URL into `CONTENT_API` in `../index.html`.

## Editing the live site

Open the site with `?edit` on the URL (e.g. `https://…/index.html?edit`).
The ✎ button then appears on ABOUT and CONTACT.
The first save asks for the edit key and remembers it in that browser, so later visits need no `?edit`.
Visitors without a remembered key see no edit control.
`?edit=off` forgets the key in that browser.

## Tests

```sh
npm test
```
