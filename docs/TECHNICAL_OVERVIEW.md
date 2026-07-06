# OAuth Technical Overview

Last reviewed: 2026-07-01

## Scope

This repository is the Nuxt 3/Nitro application used for PÖFF account, OAuth, profile, and checkout flows. For the shop work, it acts as the browser-facing backend-for-frontend between Web2021 static shop pages and Strapi v3.

The application is not a static build like Web2021. It runs as a server process and handles runtime requests for cart mutation, checkout context, profile validation, payment creation, and guest-cart claim after login.

## Main Modules

| Area | Files | Responsibility |
| --- | --- | --- |
| Checkout UI | `pages/checkout/index.vue`, `pages/checkout/components/*`, `pages/checkout/composables/*` | What the customer sees while completing the order: item details, invoice, payment, saved progress, and gift photo handling. |
| Cart API | `server/api/cart/*` | Browser-facing endpoints used by product pages and checkout to add/remove items, keep the cart alive, and read availability. |
| Checkout API | `server/api/checkout/*` | Browser-facing endpoints used by checkout to load the order context, validate customer details, update profile data, and start payment. |
| Strapi integration | `server/utils/strapi.js` | The main bridge to Strapi data: users, carts, products, orders, payments, guest cart claim, and external-service side effects. |
| Runtime resilience | `server/plugins/network-resilience.js`, `server/plugins/cleanup.js`, `server/middleware/cart-rate-limit.js` | Protection around runtime failures: retry/stale behavior, expired-cart cleanup, and limiting repeated cart calls. |
| Checkout copy | `utils/checkoutCopy*.json`, `utils/checkoutCopy.js`, `generated/checkoutCopy.json`, `scripts/fetch-checkout-copy.mjs` | Checkout labels and messages, fetched at build time when possible and backed by bundled defaults. |
| Tests | `tests/*`, `integration-tests/*`, `load/*` | Unit/source tests, mocked Playwright flows, and local load helpers. |

## Runtime Architecture

```mermaid
flowchart LR
  Browser["Browser\ncheckout page or Web2021 shop.js"]
  Nuxt["OAuth / Hunt Nuxt app\nNitro server"]
  Strapi["Web2021 Strapi v3\ncontent, carts, products, users"]
  Payments["Maksekeskus\npayment gateway"]
  Eventival["Eventival\naccount / profile data"]
  Fiona["Fiona\nbadges"]
  Moodle["Moodle\ncourse enrolment"]
  Mail["Mandrill\ntransactional email"]

  Browser -->|"HTTP /api/cart/* and /checkout"| Nuxt
  Nuxt -->|"authenticated REST calls"| Strapi
  Nuxt -->|"payment start / return"| Payments
  Nuxt -->|"profile/account sync"| Eventival
  Nuxt -->|"badge lookup"| Fiona
  Nuxt -->|"course actions"| Moodle
  Nuxt -->|"email side effects"| Mail
```

Operationally, this means OAuth is in the middle of most checkout actions. If Strapi, payment, or external profile services are slow, the customer may experience that slowness in checkout even though the public product page itself is static.

## Shop To Checkout Flow

Web2021 product pages are static, but the shop controls call OAuth at runtime. Guest users are identified with `POFF_CART_TOKEN` in browser localStorage and sent as `X-Cart-Token`. Logged-in users are identified by JWT.

```mermaid
sequenceDiagram
  participant Shop as Web2021 product page
  participant OAuth as OAuth Nitro API
  participant Strapi as Strapi v3
  participant Checkout as Checkout page
  participant Pay as Payment gateway

  Shop->>OAuth: GET /api/cart/availability?categoryId=...
  OAuth->>Strapi: check category availability / current cart
  Strapi-->>OAuth: availability + cart limit data
  OAuth-->>Shop: availability response

  Shop->>OAuth: POST /api/cart/items
  OAuth->>Strapi: ensure/reuse checkout cart
  OAuth->>Strapi: claim/peek product and update cart
  OAuth-->>Shop: minimal cart response + possible new cart token

  Shop->>OAuth: GET /api/cart
  OAuth->>Strapi: lean cart read + bulk product/category fetch
  OAuth-->>Shop: cart preview model

  Shop->>Checkout: navigate with locale, shop_url, jwt when present
  Checkout->>OAuth: GET /api/checkout/context
  OAuth->>Strapi: cart, profile, business profiles, methods
  OAuth-->>Checkout: checkout context

  Checkout->>OAuth: POST /api/checkout/pay
  OAuth->>Strapi: validate cart and create/update order
  OAuth->>Pay: create payment transaction
  Pay-->>Checkout: return/cancel/success redirect
```

This is the customer journey to verify: add an item on a static product page, open the cart preview, continue to checkout, complete item/invoice details, and start payment. Guest login adds one extra step where the guest cart is claimed after authentication.

## Cart Ownership And Recovery

The cart layer must support both logged-in users and guests:

- Logged-in cart identity comes from the JWT user id.
- Guest cart identity comes from `X-Cart-Token`.
- The server validates client cart tokens before using them.
- Existing carts can be reused even when the previous cart is no longer active; this avoids duplicate `cartToken` insert failures and keeps stale browser state from surfacing as Strapi 500s.
- Product reservations are intentionally not released by checkout cart reset paths that may run during in-flight payment recovery.

Important cart/checkout behavior is implemented in `server/utils/strapi.js`:

| Function | What it controls |
| --- | --- |
| `getCartOwner(event)` | Decides whether the cart belongs to a logged-in user or to a guest browser token. |
| `ensureCurrentCheckoutCart(owner, body)` | Finds, reuses, or creates the active cart before an add/remove/checkout action. |
| `addCheckoutCartItem(owner, body)` | Adds one product to the cart and reserves it for that customer. |
| `removeCheckoutCartItem(owner, body)` | Removes one product from the cart and refreshes the remaining cart state. |
| `getCheckoutContext(userId, locale)` | Builds the data needed to render the checkout page: cart, profile, invoice options, and payment setup. |
| `claimGuestCart(userId, cartToken)` | Moves a guest cart onto the user account after login so the customer does not lose items. |
| `payCheckoutCart(userId, body)` | Performs the final cart validation and starts the payment flow. |

## Checkout Page State

The checkout page is a Nuxt page with client-side state:

- Step state: profile, item details, invoice, payment.
- Item detail forms: owner, pickup location, gift details, email-notification choice.
- Saved progress: form values are stored locally and only restored when the cart still matches, so old invoice/item data is not applied to the wrong cart.
- Photo persistence: gift photos are kept separately in browser storage because file inputs cannot be restored like ordinary text fields.
- Cart mutations: remove operations are queued so rapid clicks do not overlap writes for the same browser tab.
- Cart context refreshes are deduplicated so one user action does not trigger several identical cart reloads at once.

```mermaid
flowchart TD
  Load["Load checkout page"] --> Context["Fetch /api/checkout/context"]
  Context --> Empty{"Cart has items?"}
  Empty -- "No" --> EmptyView["Show empty cart"]
  Empty -- "Yes" --> Restore["Restore saved progress if cart signature matches"]
  Restore --> Step1["Item details"]
  Step1 --> Step2["Invoice"]
  Step2 --> Step3["Pay"]
  Step3 --> Payment["POST /api/checkout/pay"]
  Payment --> Gateway["Payment gateway"]
```

The important behavior is that checkout should only restore saved form data when it still belongs to the same cart. If the cart changed in another tab, the page should refresh around the current cart instead of applying old details to new items.

## Checkout Copy

Checkout labels are designed to be runtime-light, meaning the checkout page should not call Strapi just to render button text or error messages:

1. `npm run build` runs `prebuild`.
2. `scripts/fetch-checkout-copy.mjs` attempts to read Strapi label groups.
3. Successful Strapi values are written to `generated/checkoutCopy.json`.
4. If Strapi is unavailable or credentials fail, the generated file is reset to `{}` and bundled defaults from `utils/checkoutCopyDefaults.json` are used.
5. The checkout app imports the generated file at build/runtime; it does not fetch labels from Strapi during normal checkout page interaction.

```mermaid
flowchart LR
  StrapiLabels["Strapi label groups"] --> FetchScript["scripts/fetch-checkout-copy.mjs"]
  Defaults["utils/checkoutCopyDefaults.json"] --> Merge["utils/checkoutCopy.js"]
  FetchScript --> Generated["generated/checkoutCopy.json"]
  Generated --> Merge
  Merge --> CheckoutUI["Checkout UI labels"]
```

## External Interfaces

| Interface | Direction | Notes |
| --- | --- | --- |
| Strapi REST | OAuth -> Strapi | Main persistence layer for users, carts, products, orders, label groups, business profiles. |
| Web2021 shop pages | Browser -> OAuth | Static product pages call OAuth when the customer checks availability, adds/removes items, opens the cart preview, or enters checkout. |
| Maksekeskus | OAuth -> gateway | Payment creation and return handling; issues here affect the final pay step. |
| Eventival | OAuth -> external service | Account/profile integration; issues here can affect login/profile-dependent checkout behavior. |
| Fiona | OAuth -> external service | Badge lookup with retry/resilience behavior. |
| Moodle | OAuth -> external service | Course-related user/enrolment actions after relevant purchases. |

## Testing Strategy

| Layer | Command | Purpose |
| --- | --- | --- |
| Unit/source tests | `npm test` | Fast checks that protect cart logic, checkout state, translations, rate limiting, and resilience behavior from regressions. |
| Mocked browser tests | `npm run test:integration` | Browser checks for checkout flows without needing real Strapi/Web2021 data; useful for repeatable regression coverage. |
| Local multi-service smoke | Manual | Run local Strapi, OAuth, and Web2021 SSG together when you need to prove the real add/remove/checkout flow end to end. |
| Load helpers | `node load/cart-flow-load.mjs` | Local/dev load probes for cart and availability paths; use deliberately because they create real traffic and cart data. |

## Operational Notes

- Required runtime configuration is declared in `nuxt.config.ts` under `runtimeConfig`.
- Local development uses `npm run dev:local`, which sources `.env.docker.local`.
- Build-time checkout label fetch depends on Strapi credentials; failure is non-fatal and falls back to defaults.
- The Nitro app should be redeployed when server code, generated checkout copy, or Nuxt build output changes.
- Web2021 SSG changes require a separate Web2021 rebuild/publish; OAuth does not regenerate static product pages.
- If only Strapi content changes, OAuth sees the change at runtime only for data it requests from Strapi. Static product-page text still depends on the Web2021 build.
