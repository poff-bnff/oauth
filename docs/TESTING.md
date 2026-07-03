# Testing Guide

This repo has two automated test layers:

- Fast unit/source tests with Vitest.
- Mocked browser integration tests with Playwright.

The browser tests are intentionally independent from Strapi, web2021, real payment providers, and dev-server data. Full multi-service smoke testing is still a separate manual/local-dev activity.

## Prerequisites

Use a Node/npm version compatible with the project lockfile. From a fresh checkout, install dependencies:

```bash
cd /home/administrator/poff/oauth
npm install
```

Install Playwright's Chromium binary once per machine or CI image:

```bash
npx playwright install chromium
```

## Fast Tests

Run the Vitest suite:

```bash
cd /home/administrator/poff/oauth
npm test
```

This covers checkout/cart business logic, Strapi integration helpers with mocked `$fetch`, checkout copy/defaults, friendly error mapping, rate limiting, cleanup scheduling, payment-method caching, and source-level regression guards.

For watch mode while developing:

```bash
npm run test:watch
```

## Browser Integration Tests

Run the mocked Playwright suite:

```bash
cd /home/administrator/poff/oauth
npm run test:integration
```

The Playwright config starts `npm run dev:local` if no Nuxt server is already available at `http://localhost:3000`. The specs mock checkout API responses in the browser, so they do not require:

- local Strapi
- web2021 SSG
- real OAuth login
- real payment provider access
- stable dev-server test data

Current browser coverage includes checkout progress reload, another-tab cart item removal, payment-cancel return, gift notification checkbox reload, and guest checkout redirect through cart claim.

## Full Local Smoke Testing

Use this only when you need to prove the full real flow across local services:

```bash
# Strapi
cd /home/administrator/poff/web2021/strapi/strapi-development
set -a
. ./.env.docker.local
set +a
export StrapiDatabaseHost=127.0.0.1
npm run start
```

```bash
# OAuth
cd /home/administrator/poff/oauth
npm run dev:local
```

```bash
# web2021 SSG
cd /home/administrator/poff/web2021/ssg
set -a
. ./.env.localhost
set +a
bash ./ssg_serve.sh
```

Then test through the browser with:

- shop/product page at `http://localhost:4000`
- checkout at `http://localhost:3000/checkout`
- Strapi admin/API at `http://localhost:1337`

These full smoke flows are not part of normal CI because they need local database state, auth state, product data, and sometimes payment-return setup.

## Recommended CI Split

- Run `npm test` on every push.
- Run `npm run test:integration` on PRs or in a separate browser-test job after `npx playwright install chromium`.
- Keep full local/dev smoke flows manual or nightly.

## Troubleshooting

If Playwright cannot find a browser:

```bash
npx playwright install chromium
```

If the Playwright server port is already occupied, stop the old Nuxt process or let Playwright reuse the existing server if it is the intended local OAuth app.

If a test unexpectedly touches real Strapi/dev data, treat it as a bug in the test. The fast and mocked browser suites should be deterministic and local-only.
