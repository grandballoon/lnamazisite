# lnamazi-content

A provisional home for the site: a Cloudflare Worker that serves the static pages in the repo root behind one shared password, and stores the editable WORK, ABOUT and CONTACT text in a KV namespace and WORK's images and video in an R2 bucket.
Signing in sets a session cookie; that session is also what authorizes saving edits.
The routes and the session design are documented at the top of [src/index.js](src/index.js).

Everything in the repo root is published except what [../.assetsignore](../.assetsignore) lists (this folder, git files, docs).

## Setup (once)

Needs Node 22 or newer; with nvm, `nvm use` picks it up from `.nvmrc`.

```sh
nvm use
npm install
npx wrangler kv namespace create CONTENT   # paste the printed id into wrangler.jsonc
npx wrangler r2 bucket create lnamazi-media   # R2 must be enabled in the dashboard first
npx wrangler secret put SITE_PASSWORD      # the password visitors type to get in
npm run deploy                             # prints the site's URL
```

Changing `SITE_PASSWORD` later signs everyone out.

## Publishing changes

Run `npm run deploy` from this folder after changing the site or the Worker.

## Editing the text

Sign in, then open the site with `?edit` on the URL (e.g. `https://…/?edit`).
The ✎ button then appears on WORK, ABOUT and CONTACT, and that browser remembers editor mode.
On WORK, drop images or video onto the panel to add them (95 MB per file at most); the ⊗ on each removes it.
`?edit=off` turns it off again.

## Local development

```sh
printf 'SITE_PASSWORD=dev\n' > .dev.vars   # git-ignored
npm run dev
```

The KV and R2 bindings are marked `remote`, so local development reads and writes the live text and media.

## Tests

```sh
npm test
```
