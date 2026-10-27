/**
 * Mock IBP OData V2 tenant for demos and tests. Fictional NZ data only.
 * Mimics PLANNING_DATA_API_SRV and MASTER_DATA_API_SRV closely enough to
 * exercise the MCP server end to end without a real IBP system.
 *
 *   npm run build && npm run mock:ibp     # listens on :4004, user demo / demo
 */
import express from "express";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

const PRODUCTS = [
  { PRDID: "FLATWHITE-1KG", PRDDESCR: "Flat White Beans 1kg", PRDFAMILY: "COFFEE" },
  { PRDID: "LONGBLACK-1KG", PRDDESCR: "Long Black Beans 1kg", PRDFAMILY: "COFFEE" },
  { PRDID: "OATMILK-1L", PRDDESCR: "Oat Milk 1L", PRDFAMILY: "DAIRYALT" },
];
const LOCATIONS = [
  { LOCID: "AKL-DC", LOCDESCR: "Auckland DC" },
  { LOCID: "CHC-DC", LOCDESCR: "Christchurch DC" },
];
const MONTHS = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"];

const planningRows = PRODUCTS.flatMap((p, pi) =>
  LOCATIONS.flatMap((l, li) =>
    MONTHS.map((m, mi) => ({
      PRDID: p.PRDID,
      LOCID: l.LOCID,
      PERIODID3_TSTAMP: `/Date(${Date.parse(`${m}T00:00:00Z`)})/`,
      CONSENSUSDEMAND: 100 + pi * 40 + li * 25 + mi * 5,
      STATISTICALFORECASTQTY: 95 + pi * 38 + li * 22 + mi * 6,
    })),
  ),
);

const metadata = (ns: string, sets: { name: string; props: [string, string, string][] }[]) => `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:sap="http://www.sap.com/Protocols/SAPData">
 <edmx:DataServices><Schema Namespace="${ns}">
${sets
  .map(
    (s) => `  <EntityType Name="${s.name}Type"><Key><PropertyRef Name="${s.props[0]![0]}"/></Key>
${s.props.map(([n, t, l]) => `   <Property Name="${n}" Type="Edm.${t}" sap:label="${l}"/>`).join("\n")}
  </EntityType>`,
  )
  .join("\n")}
  <EntityContainer Name="${ns}_Entities">
${sets.map((s) => `   <EntitySet Name="${s.name}" EntityType="${ns}.${s.name}Type"/>`).join("\n")}
  </EntityContainer>
 </Schema></edmx:DataServices></edmx:Edmx>`;

const PLANNING_META = metadata("PLANNING_DATA_API_SRV", [
  {
    name: "SAPIBP1",
    props: [
      ["PRDID", "String", "Product ID"],
      ["LOCID", "String", "Location ID"],
      ["PERIODID3_TSTAMP", "DateTime", "Month"],
      ["CONSENSUSDEMAND", "Double", "Consensus Demand"],
      ["STATISTICALFORECASTQTY", "Double", "Statistical Forecast Qty"],
    ],
  },
  { name: "HIDDENPA", props: [["PRDID", "String", "Product ID"]] },
]);
const MASTER_META = metadata("MASTER_DATA_API_SRV", [
  { name: "SAP1PRODUCT", props: [["PRDID", "String", "Product ID"], ["PRDDESCR", "String", "Description"], ["PRDFAMILY", "String", "Family"]] },
  { name: "SAP1LOCATION", props: [["LOCID", "String", "Location ID"], ["LOCDESCR", "String", "Description"]] },
]);

/** Split on a keyword (" and " / " or ") only when outside a quoted OData literal. */
function splitOutsideQuotes(text: string, sep: string): string[] {
  const parts: string[] = [];
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (inQuote && text[i + 1] === "'") { i++; continue; } // escaped quote
      inQuote = !inQuote;
    } else if (!inQuote && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Very small $filter evaluator: supports "F op 'x'" terms joined by and/or, and datetime ge/le. */
function applyFilter(rows: Record<string, unknown>[], filter?: string): Record<string, unknown>[] {
  if (!filter) return rows;
  const clauses = splitOutsideQuotes(filter, " and ").map((c) => c.trim().replace(/^\((.*)\)$/, "$1"));
  return rows.filter((r) =>
    clauses.every((clause) =>
      splitOutsideQuotes(clause, " or ").some((term) => {
        const m = /^(\w+) (eq|ne|ge|le|gt|lt) (?:datetime)?'((?:[^']|'')*)'$/.exec(term.trim());
        if (!m) return true;
        const [, f, op, raw] = m as unknown as [string, string, string, string];
        const v = raw.replace(/''/g, "'");
        const cell = String(r[f!] ?? "");
        const dm = /^\/Date\((\d+)\)\/$/.exec(cell);
        const left = dm ? Number(dm[1]) : cell;
        const right = dm ? Date.parse(`${v}Z`) : v;
        switch (op) {
          case "eq": return left === right;
          case "ne": return left !== right;
          case "ge": return left >= right;
          case "le": return left <= right;
          case "gt": return left > right;
          default: return left < right;
        }
      }),
    ),
  );
}

function serveEntity(rows: Record<string, unknown>[]): express.RequestHandler {
  return (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.$select) {
      res.status(400).json({ error: { message: { value: "$select is mandatory for this service" } } });
      return;
    }
    const cols = q.$select.split(",");
    const filtered = applyFilter(rows, q.$filter);
    const skip = Number(q.$skip ?? 0);
    const top = Number(q.$top ?? 1000);
    const results = filtered.slice(skip, skip + top).map((r) => ({
      __metadata: { type: "mock" },
      ...Object.fromEntries(cols.map((c) => [c, r[c] ?? null])),
    }));
    res.json({ d: { results } });
  };
}

export function startMockIbp(port = 4004): Promise<Server> {
  const app = express();
  app.use((req, res, next) => {
    const expected = `Basic ${Buffer.from("demo:demo").toString("base64")}`;
    if (req.headers.authorization !== expected) {
      res.status(401).json({ error: { message: { value: "Invalid credentials" } } });
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: { message: { value: "Mock is read-only" } } });
      return;
    }
    next();
  });

  const P = "/sap/opu/odata/IBP/PLANNING_DATA_API_SRV";
  const M = "/sap/opu/odata/IBP/MASTER_DATA_API_SRV";
  app.get(`${P}/`, (_q, r) => { r.json({ d: { EntitySets: ["SAPIBP1", "HIDDENPA"] } }); });
  app.get(`${P}/\\$metadata`, (_q, r) => { r.type("application/xml").send(PLANNING_META); });
  app.get(`${P}/SAPIBP1`, serveEntity(planningRows));
  app.get(`${M}/`, (_q, r) => { r.json({ d: { EntitySets: ["SAP1PRODUCT", "SAP1LOCATION"] } }); });
  app.get(`${M}/\\$metadata`, (_q, r) => { r.type("application/xml").send(MASTER_META); });
  app.get(`${M}/SAP1PRODUCT`, serveEntity(PRODUCTS));
  app.get(`${M}/SAP1LOCATION`, serveEntity(LOCATIONS));
  app.use((_req, res) => { res.status(404).json({ error: { message: { value: "Resource not found" } } }); });

  return new Promise((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT ?? 4004);
  void startMockIbp(port).then(() => console.log(`[mock-ibp] listening on :${port} (user demo / demo)`));
}
