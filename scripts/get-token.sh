#!/usr/bin/env bash
# Prints an XSUAA access token for the bound ibp-mcp-xsuaa instance (client credentials).
# Usage: ./scripts/get-token.sh            (requires: cf CLI logged in, jq, curl)
set -euo pipefail

KEY_NAME="ibp-mcp-key"
SERVICE="ibp-mcp-xsuaa"

if ! cf service-key "$SERVICE" "$KEY_NAME" >/dev/null 2>&1; then
  cf create-service-key "$SERVICE" "$KEY_NAME" >/dev/null
fi

CREDS=$(cf service-key "$SERVICE" "$KEY_NAME" | sed -n '/{/,$p')
URL=$(echo "$CREDS" | jq -r '.credentials.url // .url')
CLIENT_ID=$(echo "$CREDS" | jq -r '.credentials.clientid // .clientid')
CLIENT_SECRET=$(echo "$CREDS" | jq -r '.credentials.clientsecret // .clientsecret')

curl -sS --fail -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d "grant_type=client_credentials" \
  "$URL/oauth/token" | jq -r '.access_token'
