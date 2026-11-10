#!/usr/bin/env bash
set -euo pipefail

: "${GOOGLE_CLOUD_PROJECT:?Set the target project}"
: "${WEB_IMAGE:?Set the Artifact Registry image including its sha256 digest}"
: "${WEB_SERVICE_ACCOUNT:?Set the Cloud Run runtime service account email}"
if [[ ! "$WEB_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "WEB_IMAGE must identify an immutable image digest." >&2
  exit 2
fi

args=(
  run deploy "${WEB_SERVICE:-meeting-web}"
  --project="$GOOGLE_CLOUD_PROJECT" --region=asia-northeast1
  --image="$WEB_IMAGE" --service-account="$WEB_SERVICE_ACCOUNT"
  --no-allow-unauthenticated --invoker-iam-check --port=8080
  --min=0 --max=2 --timeout=120s
  --startup-probe=httpGet.path=/api/health,httpGet.port=8080,initialDelaySeconds=0,timeoutSeconds=3,periodSeconds=5,failureThreshold=12
  --update-env-vars="GOOGLE_CLOUD_PROJECT=$GOOGLE_CLOUD_PROJECT"
)
if [[ -n "${DB_CHECK_SECRET_VERSION:-}" ]]; then
  args+=(--update-secrets="DB_CHECK_TOKEN=$DB_CHECK_SECRET_VERSION")
fi
exec gcloud "${args[@]}"
