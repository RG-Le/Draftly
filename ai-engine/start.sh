#!/bin/sh
set -eu

# Cloud Run sets PORT (default 8080). Our FastAPI app is only for health/admin.
PORT="${PORT:-8080}"
HOST="0.0.0.0"

ROLE="${DRAFTLY_ROLE:-api}"
CELERY_APP="${CELERY_APP:-src.celery_app}"
CELERY_CONCURRENCY="${CELERY_CONCURRENCY:-4}"
CELERY_LOGLEVEL="${CELERY_LOGLEVEL:-info}"
CELERY_QUEUES="${CELERY_QUEUES:-triage-queue,draft-queue,profile-queue}"

start_api() {
  exec uvicorn src.main:app --host "$HOST" --port "$PORT"
}

start_worker() {
  # Run the health server in the background so Cloud Run startup probes pass.
  uvicorn src.main:app --host "$HOST" --port "$PORT" &
  api_pid="$!"

  # Ensure we clean up the background server on shutdown.
  trap 'kill "$api_pid" 2>/dev/null || true' INT TERM EXIT

  echo "[draftly] Starting Celery worker (app=$CELERY_APP, concurrency=$CELERY_CONCURRENCY, queues=$CELERY_QUEUES)"

  exec celery -A "$CELERY_APP" worker \
    --loglevel="$CELERY_LOGLEVEL" \
    --concurrency="$CELERY_CONCURRENCY" \
    --queues="$CELERY_QUEUES"
}

case "$ROLE" in
  api) start_api ;;
  worker) start_worker ;;
  *)
    echo "Unknown DRAFTLY_ROLE=$ROLE (expected 'api' or 'worker')" >&2
    exit 2
    ;;
esac
