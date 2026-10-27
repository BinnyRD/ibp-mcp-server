import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isAllowed, type AppConfig } from "./config.js";
import { IbpClient, IbpError } from "./ibpClient.js";
import { MetadataCache, parseServiceDocument } from "./metadata.js";
import {
  LIMITS,
  ValidationError,
  assertIdentifier,
  buildQueryString,
  extractRows,
  pageResult,
  type FilterCondition,
} from "./odata.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const scalar = z.union([z.string().max(LIMITS.maxStringValue), z.number(), z.boolean()]);

const filterSchema = z
  .array(
    z.object({
      field: z.string().describe("Attribute technical name, e.g. PRDID, LOCID, CUSTID, VERSIONID."),
      op: z.enum(["eq", "ne", "gt", "ge", "lt", "le", "in"]),
      value: z.union([scalar, z.array(scalar).max(LIMITS.maxInValues)]).describe("Single value, or a list when op is 'in'."),
    }),
  )
  .max(LIMITS.maxFilters)
  .optional()
  .describe("Structured filters, combined with AND.");

const serviceSchema = z
  .enum(["planning", "masterdata"])
  .describe("'planning' = key figures (PLANNING_DATA_API_SRV); 'masterdata' = master data (MASTER_DATA_API_SRV).");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

function fail(err: unknown): ToolResult {
  const known = err instanceof ValidationError || err instanceof IbpError;
  const message = known ? (err as Error).message : "Unexpected server error. Check the server logs.";
  if (!known) console.error("[tool error]", err);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Build a fresh MCP server instance with the four read-only IBP tools. */
export function buildMcpServer(cfg: AppConfig, client: IbpClient, metadata: MetadataCache): McpServer {
  const server = new McpServer({ name: "ibp-readonly", version: "1.0.0" });

  const servicePath = (s: "planning" | "masterdata") =>
    s === "planning" ? cfg.planningServicePath : cfg.masterDataServicePath;
  const allowList = (s: "planning" | "masterdata") =>
    s === "planning" ? cfg.allowedPlanningAreas : cfg.allowedMasterDataTypes;

  function requireAllowed(service: "planning" | "masterdata", name: string): string {
    assertIdentifier(name, service === "planning" ? "Planning area" : "Master data type");
    if (!isAllowed(allowList(service), name)) {
      const what = service === "planning" ? "Planning area" : "Master data type";
      throw new ValidationError(
        `${what} ${name} is not on this server's allow-list. Allowed: ${allowList(service).join(", ") || "(none configured)"}.`,
      );
    }
    return name;
  }

  const clampTop = (top?: number) => Math.min(top ?? Math.min(100, cfg.maxRows), cfg.maxRows);

  server.registerTool(
    "ibp_list_entities",
    {
      title: "List IBP entities",
      description:
        "List the planning areas (service 'planning') or master data types (service 'masterdata') that IBP exposes and this server allows. Start here.",
      inputSchema: { service: serviceSchema },
      annotations: READ_ONLY,
    },
    async ({ service }) => {
      try {
        const doc = await client.get(`${servicePath(service)}/?$format=json`, "application/json");
        const sets = parseServiceDocument(doc);
        const allowed = sets.filter((s) => isAllowed(allowList(service), s));
        return ok({ service, allowed, exposedButNotAllowed: sets.length - allowed.length });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "ibp_describe_entity",
    {
      title: "Describe an IBP entity",
      description:
        "List the fields of a planning area or master data type: attributes, key figures and timestamp fields (e.g. PERIODID3_TSTAMP). Use before reading data so you pick real technical names.",
      inputSchema: {
        service: serviceSchema,
        entity: z.string().describe("Planning area ID (e.g. SAPIBP1) or master data type ID."),
        nameContains: z.string().max(60).optional().describe("Optional case-insensitive filter on field name or label."),
      },
      annotations: READ_ONLY,
    },
    async ({ service, entity, nameContains }) => {
      try {
        requireAllowed(service, entity);
        const meta = await metadata.get(servicePath(service));
        const info = meta.get(entity.toUpperCase());
        if (!info) throw new ValidationError(`${entity} is not in the ${service} service metadata. Use ibp_list_entities.`);
        const needle = nameContains?.toLowerCase();
        const properties = needle
          ? info.properties.filter((p) => p.name.toLowerCase().includes(needle) || p.label?.toLowerCase().includes(needle))
          : info.properties;
        const limited = properties.slice(0, 500);
        return ok({
          entity: info.entitySet,
          totalFields: info.properties.length,
          returned: limited.length,
          ...(limited.length < properties.length ? { note: "Narrow with nameContains to see the rest." } : {}),
          fields: limited,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "ibp_read_key_figures",
    {
      title: "Read IBP key figures",
      description:
        "Read key figure values from a planning area at the planning level given by the attributes you select. Read-only. Always set a timeRange to keep results small. Results page with top/skip.",
      inputSchema: {
        planningArea: z.string().describe("Planning area ID, e.g. SAPIBP1."),
        keyFigures: z.array(z.string()).min(1).max(20).describe("Key figure IDs, e.g. CONSENSUSDEMAND."),
        attributes: z.array(z.string()).max(LIMITS.maxSelect).default([]).describe("Planning level attributes, e.g. PRDID, LOCID."),
        timeRange: z
          .object({
            field: z.string().describe("Timestamp attribute for the period level, e.g. PERIODID3_TSTAMP."),
            from: z.string().optional().describe("Inclusive ISO date, e.g. 2026-01-01."),
            to: z.string().optional().describe("Inclusive ISO date, e.g. 2026-12-31."),
          })
          .optional(),
        filters: filterSchema,
        top: z.number().int().min(1).max(5000).optional().describe(`Rows per page (capped at ${cfg.maxRows}).`),
        skip: z.number().int().min(0).optional().describe("Rows to skip, from a previous nextSkip."),
      },
      annotations: READ_ONLY,
    },
    async ({ planningArea, keyFigures, attributes, timeRange, filters, top, skip }) => {
      try {
        const area = requireAllowed("planning", planningArea);
        const pageSize = clampTop(top);
        const select = [...attributes, ...(timeRange ? [timeRange.field] : []), ...keyFigures];
        const query = buildQueryString({
          select,
          filters: filters as FilterCondition[] | undefined,
          ...(timeRange ? { timeRange } : {}),
          top: pageSize,
          skip: skip ?? 0,
        });
        const payload = await client.get(`${cfg.planningServicePath}/${area}${query}`, "application/json");
        const page = pageResult(extractRows(payload), pageSize, skip ?? 0, cfg.maxResponseChars);
        return ok({ planningArea: area, ...page });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "ibp_read_master_data",
    {
      title: "Read IBP master data",
      description: "Read records of one master data type (products, locations, customers, ...). Read-only. Results page with top/skip.",
      inputSchema: {
        masterDataType: z.string().describe("Master data type ID as listed by ibp_list_entities."),
        select: z.array(z.string()).min(1).max(LIMITS.maxSelect).describe("Attribute IDs to return, e.g. PRDID, PRDDESCR."),
        filters: filterSchema,
        top: z.number().int().min(1).max(5000).optional(),
        skip: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ masterDataType, select, filters, top, skip }) => {
      try {
        const mdt = requireAllowed("masterdata", masterDataType);
        const pageSize = clampTop(top);
        const query = buildQueryString({
          select,
          filters: filters as FilterCondition[] | undefined,
          top: pageSize,
          skip: skip ?? 0,
        });
        const payload = await client.get(`${cfg.masterDataServicePath}/${mdt}${query}`, "application/json");
        const page = pageResult(extractRows(payload), pageSize, skip ?? 0, cfg.maxResponseChars);
        return ok({ masterDataType: mdt, ...page });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
