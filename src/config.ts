import { z } from "zod";

/** Split a comma-separated env value into trimmed, non-empty, upper-cased entries. */
export function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.string().default("development"),

  /** Name of the BTP Destination that points at the IBP tenant (SAP_COM_0720 communication user). */
  IBP_DESTINATION: z.string().min(1).default("IBP"),
  IBP_PLANNING_SERVICE_PATH: z.string().startsWith("/").default("/sap/opu/odata/IBP/PLANNING_DATA_API_SRV"),
  IBP_MASTER_DATA_SERVICE_PATH: z.string().startsWith("/").default("/sap/opu/odata/IBP/MASTER_DATA_API_SRV"),

  /** Allow-lists. Empty = nothing allowed (fail closed). "*" = everything the IBP side exposes. */
  ALLOWED_PLANNING_AREAS: z.string().default(""),
  ALLOWED_MASTER_DATA_TYPES: z.string().default(""),

  MAX_ROWS: z.coerce.number().int().min(1).max(5000).default(1000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  /** Upper bound on the JSON text returned to the model per call. */
  MAX_RESPONSE_CHARS: z.coerce.number().int().min(10_000).max(2_000_000).default(200_000),

  AUTH_MODE: z.enum(["xsuaa", "none"]).default("xsuaa"),
  REQUIRED_SCOPE: z.string().min(1).default("Read"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
});

export interface AppConfig {
  port: number;
  isProduction: boolean;
  destinationName: string;
  planningServicePath: string;
  masterDataServicePath: string;
  allowedPlanningAreas: string[];
  allowedMasterDataTypes: string[];
  maxRows: number;
  requestTimeoutMs: number;
  maxResponseChars: number;
  authMode: "xsuaa" | "none";
  requiredScope: string;
  rateLimitPerMinute: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";

  if (isProduction && e.AUTH_MODE === "none") {
    throw new Error("AUTH_MODE=none is not allowed when NODE_ENV=production.");
  }

  return {
    port: e.PORT,
    isProduction,
    destinationName: e.IBP_DESTINATION,
    planningServicePath: e.IBP_PLANNING_SERVICE_PATH.replace(/\/+$/, ""),
    masterDataServicePath: e.IBP_MASTER_DATA_SERVICE_PATH.replace(/\/+$/, ""),
    allowedPlanningAreas: parseList(e.ALLOWED_PLANNING_AREAS),
    allowedMasterDataTypes: parseList(e.ALLOWED_MASTER_DATA_TYPES),
    maxRows: e.MAX_ROWS,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    maxResponseChars: e.MAX_RESPONSE_CHARS,
    authMode: e.AUTH_MODE,
    requiredScope: e.REQUIRED_SCOPE,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
  };
}

/** True when `name` is allowed by the list ("*" allows everything; empty list allows nothing). */
export function isAllowed(list: string[], name: string): boolean {
  if (list.includes("*")) return true;
  return list.includes(name.toUpperCase());
}
