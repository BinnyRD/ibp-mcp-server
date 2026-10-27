import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ValidationError,
  buildFilter,
  buildQueryString,
  cleanRow,
  dateTimeLiteral,
  extractRows,
  literal,
  pageResult,
} from "../src/odata.js";
import { isAllowed, loadConfig, parseList } from "../src/config.js";
import { parseMetadata, parseServiceDocument } from "../src/metadata.js";

test("string literals escape single quotes (no filter injection)", () => {
  assert.equal(literal("O'Brien"), "'O''Brien'");
  assert.equal(literal("x' or 1 eq 1 or 'a"), "'x'' or 1 eq 1 or ''a'");
});

test("rejects control characters, non-finite numbers and oversized values", () => {
  assert.throws(() => literal("a\nb"), ValidationError);
  assert.throws(() => literal(Number.NaN), ValidationError);
  assert.throws(() => literal("x".repeat(201)), ValidationError);
});

test("rejects invalid identifiers", () => {
  assert.throws(() => buildFilter([{ field: "PRDID eq 'x' or", op: "eq", value: "a" }]), ValidationError);
  assert.throws(() => buildQueryString({ select: ["PRDID,LOCID"], top: 10 }), ValidationError);
  assert.throws(() => buildQueryString({ select: ["../x"], top: 10 }), ValidationError);
});

test("'in' expands to OR group; single value stays plain", () => {
  assert.equal(
    buildFilter([{ field: "LOCID", op: "in", value: ["NZ01", "AU01"] }]),
    "(LOCID eq 'NZ01' or LOCID eq 'AU01')",
  );
  assert.equal(buildFilter([{ field: "LOCID", op: "in", value: ["NZ01"] }]), "LOCID eq 'NZ01'");
  assert.throws(() => buildFilter([{ field: "LOCID", op: "eq", value: ["a", "b"] }]), ValidationError);
});

test("time range builds inclusive UTC datetime bounds", () => {
  assert.equal(
    buildFilter([], { field: "PERIODID3_TSTAMP", from: "2026-01-01", to: "2026-03-31" }),
    "PERIODID3_TSTAMP ge datetime'2026-01-01T00:00:00' and PERIODID3_TSTAMP le datetime'2026-03-31T00:00:00'",
  );
  assert.equal(dateTimeLiteral("2026-01-01T13:00:00+13:00", "x"), "datetime'2026-01-01T00:00:00'");
  assert.throws(() => buildFilter([], { field: "PERIODID3_TSTAMP", from: "2026-05-01", to: "2026-01-01" }), ValidationError);
  assert.throws(() => dateTimeLiteral("2026-02-30", "x"), ValidationError);
  assert.throws(() => dateTimeLiteral("next week", "x"), ValidationError);
});

test("query string requests top+1, dedupes select and encodes the filter", () => {
  const q = buildQueryString({
    select: ["PRDID", "PRDID", "CONSENSUSDEMAND"],
    filters: [{ field: "PRDID", op: "eq", value: "A B" }],
    top: 50,
    skip: 100,
  });
  assert.equal(
    q,
    "?$select=PRDID%2CCONSENSUSDEMAND&$filter=PRDID%20eq%20'A%20B'&$top=51&$skip=100&$format=json",
  );
});

test("extractRows handles d.results, converts /Date()/ and drops __metadata", () => {
  const rows = extractRows({
    d: { results: [{ __metadata: { uri: "x" }, PRDID: "P1", PERIODID3_TSTAMP: "/Date(1767225600000)/" }] },
  });
  assert.deepEqual(rows, [{ PRDID: "P1", PERIODID3_TSTAMP: "2026-01-01T00:00:00.000Z" }]);
  assert.throws(() => extractRows({ value: [] }));
  assert.deepEqual(cleanRow({ A: 1, B: null }), { A: 1, B: null });
});

test("pageResult detects more rows via top+1 and respects the size budget", () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ i, pad: "x".repeat(1000) }));
  const p = pageResult(rows, 10, 0, 1_000_000);
  assert.equal(p.rowCount, 10);
  assert.equal(p.hasMore, true);
  assert.equal(p.nextSkip, 10);

  const small = pageResult(rows, 10, 20, 3000);
  assert.ok(small.rowCount < 10);
  assert.equal(small.truncatedForSize, true);
  assert.equal(small.nextSkip, 20 + small.rowCount);

  const last = pageResult(rows.slice(0, 3), 10, 0, 1_000_000);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextSkip, undefined);
});

test("config: allow-lists fail closed, '*' opens, production refuses AUTH_MODE=none", () => {
  assert.deepEqual(parseList(" sapibp1, ,SAP1PRODUCT "), ["SAPIBP1", "SAP1PRODUCT"]);
  assert.equal(isAllowed([], "SAPIBP1"), false);
  assert.equal(isAllowed(["*"], "ANY"), true);
  assert.equal(isAllowed(["SAPIBP1"], "sapibp1"), true);
  assert.throws(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "none" }), /not allowed/);
  assert.throws(() => loadConfig({ MAX_ROWS: "999999" }), /Invalid configuration/);
  assert.equal(loadConfig({}).authMode, "xsuaa");
});

test("metadata and service document parsing", () => {
  const xml = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:sap="http://www.sap.com/Protocols/SAPData">
 <edmx:DataServices><Schema Namespace="IBP">
  <EntityType Name="SAPIBP1Type"><Key><PropertyRef Name="ID"/></Key>
   <Property Name="ID" Type="Edm.String"/>
   <Property Name="PRDID" Type="Edm.String" sap:label="Product ID"/>
   <Property Name="CONSENSUSDEMAND" Type="Edm.Double" sap:label="Consensus Demand"/>
  </EntityType>
  <EntityContainer Name="C"><EntitySet Name="SAPIBP1" EntityType="IBP.SAPIBP1Type"/></EntityContainer>
 </Schema></edmx:DataServices></edmx:Edmx>`;
  const meta = parseMetadata(xml);
  const e = meta.get("SAPIBP1");
  assert.ok(e);
  assert.equal(e.properties.length, 3);
  assert.deepEqual(e.properties[1], { name: "PRDID", type: "String", label: "Product ID", isKey: false });
  assert.equal(e.properties[0]?.isKey, true);
  assert.deepEqual(parseServiceDocument({ d: { EntitySets: ["SAPIBP1", 5] } }), ["SAPIBP1"]);
});
