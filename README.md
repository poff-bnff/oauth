# Auth service for [PÖFF : BNFF](https://poff.ee)

## Setup

Make sure to install the dependencies:

```bash
npm install
```

Make .env file from .env.example and fill in the values.

## Development Server

Start the development server on http://localhost:3000

```bash
npm run dev
```

## Production

Build the application for production:

```bash
npm run build
```

Locally preview production build:

```bash
npm run preview
```

Run production build:

```bash
npm run start
```

## Health Check

The service exposes a liveness endpoint at `GET /api/health`.

```bash
curl http://localhost:3000/api/health
```

Example response:

```json
{
  "status": "ok",
  "timestamp": "2026-04-28T10:20:30.123Z",
  "version": "1.0.0"
}
```

Returns `200` when the service is running. Use this for uptime monitoring and container health checks.

Look at the [Nuxt 3 documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.
