#!/usr/bin/env bash
# Fetches the harness installer from the Shrike API with a job id token and
# runs it only when the bytes match the digest committed here.
set -euo pipefail

: "${SHRIKE_API_URL:?SHRIKE_API_URL is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?the workflow needs permissions: id-token write}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?the workflow needs permissions: id-token write}"

base=${SHRIKE_API_URL%/}
script=$(mktemp)
trap 'rm -f "$script"' EXIT

token=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --header "authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=shrike" | sed -n 's/.*"value":"\([^"]*\)".*/\1/p')
: "${token:?the job could not mint an id token, it needs permissions: id-token write}"

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 --header "authorization: Bearer ${token}" "${base}/install.sh" --output "$script"
printf '%s  %s\n' "${INSTALLER_SHA:?INSTALLER_SHA is required}" "$script" | sha256sum --check --strict - >/dev/null || {
  echo "::error::harness installer digest mismatch, refusing to run"
  exit 1
}
bash "$script"
