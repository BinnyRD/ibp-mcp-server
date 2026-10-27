# IBP MCP Server (read-only) for SAP BTP

[![CI](https://github.com/BinnyRD/ibp-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/BinnyRD/ibp-mcp-server/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP server that lets Claude (or any MCP client) **read** SAP IBP master data and key figures through IBP's standard OData APIs. It runs on SAP BTP Cloud Foundry, reaches IBP through a BTP Destination, and is protected by XSUAA.

It never writes to IBP: the only HTTP method it sends is `GET`, and every tool is marked read-only.

## What Claude gets

| Tool | Purpose |
|---|---|
| `ibp_list_entities` | Planning areas or master data types that IBP exposes **and** this server allows |
| `ibp_describe_entity` | Fields of a planning area / master data type (attributes, key figures, `PERIODID*_TSTAMP`), searchable by name or label |
| `ibp_read_key_figures` | Key figure values at a chosen planning level, with time range, filters and paging |
| `ibp_read_master_data` | Master data records with filters and paging |

Example prompt once connected: *"Compare consensus demand vs statistical forecast for coffee products at the Auckland DC for Q1 2026."*

## Architecture

```
Claude ──HTTPS + Bearer JWT──▶ ibp-mcp-server (CF app)
                                 │  XSUAA: validates token, requires $XSAPPNAME.Read
                                 │  Allow-lists, input validation, row & size caps
                                 ▼
                         BTP Destination "IBP" (Basic auth, communication user)
                                 ▼
             IBP  /IBP/PLANNING_DATA_API_SRV   (key figures)
                  /IBP/MASTER_DATA_API_SRV     (master data)     ← SAP_COM_0720
```

Why these services: SAP positions `PLANNING_DATA_API_SRV` and `MASTER_DATA_API_SRV` (scenario **SAP_COM_0720**) for external systems; `EXTRACT_ODATA_SRV` is aimed at SAP Analytics Cloud. Service paths are configurable if your landscape differs.

## Security model (why it is safe to put in front of a client tenant)

- **Read-only by construction**: GET only; the IBP communication user should also hold read-only authorisation.
- **Two allow-lists, fail closed**: IBP's Global Configuration decides what the API exposes; this server's `ALLOWED_PLANNING_AREAS` / `ALLOWED_MASTER_DATA_TYPES` narrow it further. Empty list = nothing allowed.
- **No raw OData from the model**: filters are structured (`field`, `op`, `value`); field names must match `^[A-Za-z_][A-Za-z0-9_]{0,59}$`, string values are quote-escaped, control characters rejected. Injection attempts are covered by tests.
- **Bounded results**: `MAX_ROWS` (default 1000, hard max 5000) and `MAX_RESPONSE_CHARS` cap every response; paging via `nextSkip`.
- **Auth required**: in `xsuaa` mode the app refuses to start without an XSUAA binding; `AUTH_MODE=none` is rejected when `NODE_ENV=production`.
- **No credential leakage**: IBP credentials live only in the BTP Destination; error messages return IBP's message text, never raw responses or headers.
- Rate limiting per client IP (`RATE_LIMIT_PER_MINUTE`).

> Get written IT/security sign-off from the client before connecting to a production tenant, and agree which planning areas and master data types may be exposed. Planning data is commercially sensitive.

## 1. Try it locally in 2 minutes (no IBP needed)

Requires Node.js 20+.

```bash
npm ci
npm test        # 10 unit tests
npm run smoke   # mock IBP + real MCP client, calls every tool
```

Run the demo stack for Claude Code / Claude Desktop:

```bash
npm run build
npm run mock:ibp &       # fictional NZ data on :4004, user demo / demo

AUTH_MODE=none \
ALLOWED_PLANNING_AREAS=SAPIBP1 \
ALLOWED_MASTER_DATA_TYPES=SAP1PRODUCT,SAP1LOCATION \
destinations='[{"name":"IBP","url":"http://localhost:4004","authentication":"BasicAuthentication","username":"demo","password":"demo"}]' \
npm start

claude mcp add --transport http ibp-demo http://localhost:8080/mcp
```

This is the safe portfolio demo: realistic IBP shapes, zero client data.

## 2. IBP setup (client tenant)

1. **Maintain Communication Users** → create a user, generate a strong password.
2. **Communication Systems** → new system, tick **Inbound Only**, assign the user.
3. **Communication Arrangements** → new arrangement for **SAP_COM_0720**, select the system. Note the service URLs shown.
4. **Global Configuration** → expose only what is needed:
   - `FLEXQUERY` / `PLANNINGAREA` → e.g. `SAPIBP1`
   - `FLEXQUERY` / `RELEVANT_MDT_FOR_MD_API` → the master data types (avoid `*` on client systems)
5. Ensure the business user behind the arrangement has **read** access to those planning areas.

## 3. BTP setup (Cloud Foundry)

```bash
cf login -a https://api.cf.<region>.hana.ondemand.com

cf create-service xsuaa application ibp-mcp-xsuaa -c xs-security.json
cf create-service destination lite ibp-mcp-destination
```

In the BTP cockpit → **Connectivity → Destinations → New Destination**:

| Field | Value |
|---|---|
| Name | `IBP` |
| Type | HTTP |
| URL | your IBP API host, e.g. `https://myXXXXXX-api.scmibp.ondemand.com` |
| Proxy Type | Internet |
| Authentication | BasicAuthentication |
| User / Password | communication user from step 2 |

Edit `manifest.yml` → set `ALLOWED_PLANNING_AREAS` and `ALLOWED_MASTER_DATA_TYPES`. Then:

```bash
npm ci && npm run build      # dist/ is pushed; CF installs production deps only
cf push
```

Assign the **IBP_MCP_Reader** role collection to users who should use it (for user-based tokens).

## 4. Connect Claude

Get a token (client credentials, valid 1 hour):

```bash
TOKEN=$(./scripts/get-token.sh)
```

**Claude Code**

```bash
claude mcp add --transport http ibp https://<app-route>/mcp --header "Authorization: Bearer $TOKEN"
```

**Claude Desktop** (`claude_desktop_config.json`, uses the `mcp-remote` bridge):

```json
{
  "mcpServers": {
    "ibp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<app-route>/mcp", "--header", "Authorization: Bearer ${IBP_TOKEN}"],
      "env": { "IBP_TOKEN": "<paste token>" }
    }
  }
}
```

Tokens expire after `token-validity` (3600 s in `xs-security.json`). Refresh with the script; raise the validity only if the client's security policy allows it.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `IBP_DESTINATION` | `IBP` | BTP Destination name |
| `IBP_PLANNING_SERVICE_PATH` | `/sap/opu/odata/IBP/PLANNING_DATA_API_SRV` | |
| `IBP_MASTER_DATA_SERVICE_PATH` | `/sap/opu/odata/IBP/MASTER_DATA_API_SRV` | |
| `ALLOWED_PLANNING_AREAS` | *(empty = none)* | comma-separated, `*` = all exposed |
| `ALLOWED_MASTER_DATA_TYPES` | *(empty = none)* | comma-separated, `*` = all exposed |
| `MAX_ROWS` | `1000` | 1–5000 |
| `MAX_RESPONSE_CHARS` | `200000` | keeps tool output within model context |
| `REQUEST_TIMEOUT_MS` | `30000` | |
| `AUTH_MODE` | `xsuaa` | `none` for local only |
| `REQUIRED_SCOPE` | `Read` | local scope checked on every call |
| `RATE_LIMIT_PER_MINUTE` | `120` | per client IP |

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `HTTP 401` from IBP | Wrong communication user/password in the Destination |
| `HTTP 403` from IBP | Arrangement inactive, or planning area / MDT missing from Global Configuration |
| `HTTP 404` from IBP | Name not exposed by the API; run `ibp_list_entities` |
| `not on this server's allow-list` | Add it to `ALLOWED_*` in `manifest.yml` and `cf push` (or `cf set-env` + `cf restage`) |
| App crashes: `No XSUAA service bound` | `cf bind-service ibp-mcp-server ibp-mcp-xsuaa` then `cf restage` |
| `401` from the MCP server | Token missing/expired; rerun `get-token.sh` |
| Timeouts | Narrow `timeRange`, add filters, lower `top` |

## Known limits / next steps

- Your tenant's exact field names (e.g. which `PERIODID*_TSTAMP` matches the planning level) vary by configuration; the model discovers them with `ibp_describe_entity`. Verify the first queries against a planning view in Excel.
- Version/scenario: add a filter on the version attribute (e.g. `VERSIONID`) if you need a non-baseline version.
- **claude.ai custom connectors** need OAuth with discovery; XSUAA does not offer dynamic client registration. Supporting that is a v2 item (OAuth protected-resource metadata + pre-registered client). Claude Code and Claude Desktop work today via bearer token.
- `npm audit` reports a `node-forge` advisory inside SAP Cloud SDK's JKS keystore support. This server uses Basic-auth destinations, so that code path is not used; upgrade `@sap-cloud-sdk/*` when SAP ships a fix.
- Delta reads and write-back are deliberately out of scope.

## Disclaimer

Independent open-source project, not affiliated with or endorsed by SAP. SAP, SAP IBP and SAP BTP are trademarks of SAP SE. Demo data is fictional. Provided as-is under the MIT licence; you are responsible for security review before connecting to any IBP tenant.

## Author

Rakesh Binny Dasari, SAP IBP delivery lead, Auckland. [LinkedIn](https://www.linkedin.com/in/rakeshbinny)
