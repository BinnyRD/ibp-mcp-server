/**
 * End-to-end smoke test: starts the mock IBP tenant, starts the MCP server
 * (AUTH_MODE=none, local only), connects a real MCP client and calls every tool.
 *
 *   npm run smoke
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockIbp } from "./mock-ibp.js";

const MOCK_PORT = 4904;
const MCP_PORT = 8904;

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
const json = (r: unknown) => JSON.parse((r as TextResult).content[0]!.text);

async function main() {
  const mock = await startMockIbp(MOCK_PORT);
  const server = spawn(process.execPath, ["dist/src/server.js"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(MCP_PORT),
      AUTH_MODE: "none",
      ALLOWED_PLANNING_AREAS: "SAPIBP1",
      ALLOWED_MASTER_DATA_TYPES: "SAP1PRODUCT,SAP1LOCATION",
      MAX_ROWS: "500",
      destinations: JSON.stringify([
        { name: "IBP", url: `http://localhost:${MOCK_PORT}`, authentication: "BasicAuthentication", username: "demo", password: "demo" },
      ]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stdout.on("data", (d) => (logs += d));
  server.stderr.on("data", (d) => (logs += d));

  try {
    for (let i = 0; i < 50 && !logs.includes("listening"); i++) await sleep(100);
    assert.ok(logs.includes("listening"), `server did not start:\n${logs}`);

    const health = await fetch(`http://localhost:${MCP_PORT}/health`);
    assert.equal(health.status, 200);
    assert.equal((await fetch(`http://localhost:${MCP_PORT}/mcp`)).status, 405);

    const client = new Client({ name: "smoke", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${MCP_PORT}/mcp`)));

    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "ibp_describe_entity", "ibp_list_entities", "ibp_read_key_figures", "ibp_read_master_data",
    ]);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), "all tools must be read-only");
    console.log("✓ 4 tools listed, all read-only");

    const list = json(await client.callTool({ name: "ibp_list_entities", arguments: { service: "planning" } }));
    assert.deepEqual(list.allowed, ["SAPIBP1"]);
    assert.equal(list.exposedButNotAllowed, 1);
    console.log("✓ ibp_list_entities hides non-allow-listed planning area");

    const desc = json(await client.callTool({ name: "ibp_describe_entity", arguments: { service: "planning", entity: "SAPIBP1", nameContains: "demand" } }));
    assert.deepEqual(desc.fields.map((f: { name: string }) => f.name), ["CONSENSUSDEMAND"]);
    console.log("✓ ibp_describe_entity finds key figure by label");

    const kf = json(await client.callTool({
      name: "ibp_read_key_figures",
      arguments: {
        planningArea: "SAPIBP1",
        keyFigures: ["CONSENSUSDEMAND"],
        attributes: ["PRDID", "LOCID"],
        timeRange: { field: "PERIODID3_TSTAMP", from: "2026-01-01", to: "2026-03-31" },
        filters: [{ field: "LOCID", op: "eq", value: "AKL-DC" }, { field: "PRDID", op: "in", value: ["FLATWHITE-1KG", "OATMILK-1L"] }],
        top: 4,
      },
    }));
    assert.equal(kf.rowCount, 4);
    assert.equal(kf.hasMore, true);
    assert.equal(kf.nextSkip, 4);
    assert.equal(kf.rows[0].PERIODID3_TSTAMP, "2026-01-01T00:00:00.000Z");
    assert.ok(kf.rows.every((r: { LOCID: string }) => r.LOCID === "AKL-DC"));

    const kf2 = json(await client.callTool({
      name: "ibp_read_key_figures",
      arguments: {
        planningArea: "SAPIBP1", keyFigures: ["CONSENSUSDEMAND"], attributes: ["PRDID", "LOCID"],
        timeRange: { field: "PERIODID3_TSTAMP", from: "2026-01-01", to: "2026-03-31" },
        filters: [{ field: "LOCID", op: "eq", value: "AKL-DC" }, { field: "PRDID", op: "in", value: ["FLATWHITE-1KG", "OATMILK-1L"] }],
        top: 4, skip: 4,
      },
    }));
    assert.equal(kf2.rowCount, 2);
    assert.equal(kf2.hasMore, false);
    console.log("✓ ibp_read_key_figures: filters, time range, date conversion and paging (4 + 2 = 6 rows)");

    const md = json(await client.callTool({ name: "ibp_read_master_data", arguments: { masterDataType: "SAP1PRODUCT", select: ["PRDID", "PRDDESCR"], filters: [{ field: "PRDFAMILY", op: "eq", value: "COFFEE" }] } }));
    assert.equal(md.rowCount, 2);
    assert.equal(md.rows[0].__metadata, undefined);
    console.log("✓ ibp_read_master_data with filter");

    const blocked = (await client.callTool({ name: "ibp_read_key_figures", arguments: { planningArea: "HIDDENPA", keyFigures: ["X"] } })) as TextResult;
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0]!.text, /allow-list/);
    console.log("✓ non-allow-listed planning area refused");

    const injection = (await client.callTool({ name: "ibp_read_master_data", arguments: { masterDataType: "SAP1PRODUCT", select: ["PRDID"], filters: [{ field: "PRDID eq 'x' or PRDID", op: "ne", value: "" }] } })) as TextResult;
    assert.equal(injection.isError, true);
    const quoted = json(await client.callTool({ name: "ibp_read_master_data", arguments: { masterDataType: "SAP1PRODUCT", select: ["PRDID"], filters: [{ field: "PRDID", op: "eq", value: "x' or PRDID ne '" }] } }));
    assert.equal(quoted.rowCount, 0);
    console.log("✓ filter injection blocked (bad field name rejected, quotes escaped -> 0 rows)");

    const badDate = (await client.callTool({ name: "ibp_read_key_figures", arguments: { planningArea: "SAPIBP1", keyFigures: ["CONSENSUSDEMAND"], timeRange: { field: "PERIODID3_TSTAMP", from: "2026-02-30" } } })) as TextResult;
    assert.equal(badDate.isError, true);
    console.log("✓ impossible date refused");

    await client.close();
    console.log("\nSMOKE TEST PASSED");
  } catch (err) {
    console.error("SMOKE TEST FAILED\n", err, "\n--- server logs ---\n", logs);
    process.exitCode = 1;
  } finally {
    server.kill("SIGTERM");
    mock.close();
  }
}

void main();
