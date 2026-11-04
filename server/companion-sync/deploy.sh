#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Engine and the Docker Compose plugin are required." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created server/companion-sync/.env from the template."
  echo "Edit .env with your domain and three independent secrets, then run this script again."
  exit 2
fi

set -a
# shellcheck disable=SC1091
source ./.env
set +a

required_vars=(
  COMPANION_DOMAIN ACME_EMAIL POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
  COMPANION_BOOTSTRAP_TOKEN COMPANION_TOKEN_PEPPER COMPANION_CORS_ORIGINS
)
for name in "${required_vars[@]}"; do
  value="${!name:-}"
  if [[ -z "$value" || "$value" == *replace-* || "$value" == "sync.example.com" || "$value" == "admin@example.com" ]]; then
    echo "Set a real value for $name in .env before deployment." >&2
    exit 1
  fi
done

for name in POSTGRES_PASSWORD COMPANION_BOOTSTRAP_TOKEN COMPANION_TOKEN_PEPPER; do
  value="${!name}"
  if [[ "${#value}" -lt 32 ]]; then
    echo "$name must contain at least 32 characters." >&2
    exit 1
  fi
done

if [[ "$COMPANION_BOOTSTRAP_TOKEN" == "$COMPANION_TOKEN_PEPPER" || "$POSTGRES_PASSWORD" == "$COMPANION_BOOTSTRAP_TOKEN" || "$POSTGRES_PASSWORD" == "$COMPANION_TOKEN_PEPPER" ]]; then
  echo "Database password, bootstrap token and token pepper must be different values." >&2
  exit 1
fi

if [[ "$COMPANION_CORS_ORIGINS" == *"*"* ]]; then
  echo "Wildcard CORS origins are not allowed." >&2
  exit 1
fi

echo "[1/4] Validating Compose configuration..."
docker compose config --quiet

echo "[2/4] Starting the private PostgreSQL database..."
docker compose up -d db

echo "[3/4] Building the API image and applying database migrations..."
docker compose build api
docker compose run --rm --no-deps --entrypoint node api server/companion-sync/migrate.mjs

echo "[4/4] Starting the API and HTTPS reverse proxy..."
docker compose up -d api caddy

echo "Waiting for the HTTPS health endpoint..."
curl --fail --silent --show-error --retry 20 --retry-delay 3 --retry-connrefused \
  "https://${COMPANION_DOMAIN}/v1/health"

echo
echo "Companion Sync is responding over HTTPS."
echo "Next: initialize the owner account using the one-time bootstrap endpoint in README.md."
