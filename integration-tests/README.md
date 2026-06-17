# Integration tests

This folder contains browser-level Playwright tests that are intentionally separate from the fast Vitest suite.

Run unit/source tests:

```bash
npm test
```

Run mocked browser integration tests:

```bash
npm run test:integration
```

The Playwright config starts `npm run dev:local` when no local Nuxt server is already running at `http://localhost:3000`. The current specs mock checkout API responses in the browser, so they do not require Strapi, web2021, or stable dev-server data.

Install browser binaries once per machine or CI image:

```bash
npx playwright install chromium
```

Recommended CI split:

- Run `npm test` on every push.
- Run `npm run test:integration` on PRs or in a separate job after Playwright browsers are installed.
- Keep full multi-service smoke flows separate from these mocked tests, because those need local/dev Strapi, web2021 SSG, auth, and payment-return data.
