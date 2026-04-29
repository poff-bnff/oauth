#!/bin/sh
set -eu

cd /app

# Validate required environment variables
echo "[oauth] Validating required environment variables..."
REQUIRED_VARS="NUXT_JWT_SECRET NUXT_STRAPI_URL NUXT_STRAPI_USER NUXT_STRAPI_PASSWORD NUXT_SYNC_SECRET NUXT_PUBLIC_URL NUXT_OAUTH_CLIENT_SECRET"
MISSING_VARS=""

for var in $REQUIRED_VARS; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    MISSING_VARS="$MISSING_VARS\n  - $var"
  fi
done

if [ -n "$MISSING_VARS" ]; then
  echo ""
  echo "❌ Missing required environment variables:$MISSING_VARS"
  echo ""
  echo "Set these vars in .env.docker.local or docker-compose.yml environment."
  echo "See .env.docker.local.example for reference."
  echo ""
  exit 1
fi

echo "[oauth] ✓ All required environment variables set"
echo ""

if [ ! -d node_modules/nuxt ]; then
  echo "[oauth] Installing dependencies into container volume..."
  npm install --no-audit --progress=false
else
  echo "[oauth] Reusing existing node_modules volume."
fi

MODE="${1:-dev}"
shift || true

case "$MODE" in
  dev)
    exec npm run dev -- --host 0.0.0.0 --port 3000
    ;;
  build)
    exec npm run build
    ;;
  start)
    if [ ! -f .output/server/index.mjs ]; then
      npm run build
    fi
    exec npm run start
    ;;
  idle)
    echo "[oauth] Ready. Use 'docker compose exec oauth sh ./docker-entrypoint.local.sh dev' to run Nuxt manually."
    exec tail -f /dev/null
    ;;
  *)
    echo "[oauth] Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
