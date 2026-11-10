#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# An isolated project and an assigned port leave regular Compose sessions alone.
check_directory=$(mktemp -d "${TMPDIR:-/tmp}/ai-classroom-check-XXXXXXXX")
check_project=$(basename "$check_directory" | tr '[:upper:]' '[:lower:]')

compose() {
  WEB_PORT=0 docker compose --project-name "$check_project" \
    --file "$repository_root/compose.yaml" "$@"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    compose logs --no-color || true
  fi
  # Only this check's containers, network and auto-named service images are removed.
  if ! compose down --remove-orphans --rmi local; then
    if [ "$status" -eq 0 ]; then status=1; fi
  fi
  if ! rmdir "$check_directory"; then
    if [ "$status" -eq 0 ]; then status=1; fi
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Checking Docker project: $check_project"
compose build web agent-check
compose run --rm agent-check
compose up -d --wait --wait-timeout 90 web
endpoint=$(compose port web 8080)
curl --fail --silent --show-error --max-time 10 "http://$endpoint/api/health"
