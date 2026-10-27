/**
 * Pure OData V2 query building and response shaping. No network access here,
 * so every rule can be unit-tested. The model never supplies raw $filter text:
 * it supplies structured conditions that are validated and escaped here.
 */

/** IBP technical names: attributes, key figures, planning areas, master data types. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;

export const LIMITS = {
  maxSelect: 80,
  maxFilters: 20,
  maxInValues: 100,
  maxStringValue: 200,
} as const;

export type Scalar = string | number | boolean;
export type FilterOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "in";

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value: Scalar | Scalar[];
}

export interface TimeRange {
  /** Timestamp attribute of the planning level, e.g. PERIODID3_TSTAMP. */
  field: string;
  /** ISO date or date-time, inclusive. */
  from?: string;
  /** ISO date or date-time, inclusive. */
  to?: string;
}

export interface QueryOptions {
  select: string[];
  filters?: FilterCondition[];
  timeRange?: TimeRange;
  top: number;
  skip?: number;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function assertIdentifier(name: string, what: string): string {
  if (typeof name !== "string" || !IDENTIFIER.test(name)) {
    throw new ValidationError(
      `${what} "${String(name)}" is not a valid IBP technical name (letters, digits, underscore; max 60 chars).`,
    );
  }
  return name;
}

/** Render one value as an OData V2 literal. Strings are single-quoted with quotes doubled. */
export function literal(value: Scalar): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(`Number ${value} is not finite.`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "string") throw new ValidationError("Filter values must be string, number or boolean.");
  if (value.length > LIMITS.maxStringValue) {
    throw new ValidationError(`Filter value longer than ${LIMITS.maxStringValue} characters.`);
  }
  // Reject control characters outright; they have no legitimate use in IBP keys.
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError("Filter value contains control characters.");
  return `'${value.replace(/'/g, "''")}'`;
}

/** Convert an ISO date/date-time into an OData V2 datetime literal (UTC, seconds precision). */
export function dateTimeLiteral(iso: string, what: string): string {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(iso)) {
    throw new ValidationError(`${what} "${String(iso)}" must be an ISO date like 2026-01-01 or 2026-01-01T00:00:00Z.`);
  }
  // Dates without a zone are treated as UTC so results never depend on server locale.
  const normalised = iso.length === 10 ? `${iso}T00:00:00Z` : /(Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(normalised);
  // JS rolls impossible dates over (2026-02-30 -> 2026-03-02); check the calendar date itself.
  const [y, m, day] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  const calendar = new Date(Date.UTC(y, m - 1, day));
  if (
    Number.isNaN(d.getTime()) ||
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== m - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new ValidationError(`${what} "${iso}" is not a real date.`);
  }
  return `datetime'${d.toISOString().slice(0, 19)}'`;
}

function conditionToFilter(c: FilterCondition): string {
  const field = assertIdentifier(c.field, "Filter field");
  if (c.op === "in") {
    const values = Array.isArray(c.value) ? c.value : [c.value];
    if (values.length === 0) throw new ValidationError(`"in" filter on ${field} needs at least one value.`);
    if (values.length > LIMITS.maxInValues) {
      throw new ValidationError(`"in" filter on ${field} has more than ${LIMITS.maxInValues} values.`);
    }
    const parts = values.map((v) => `${field} eq ${literal(v)}`);
    return parts.length === 1 ? parts[0]! : `(${parts.join(" or ")})`;
  }
  if (Array.isArray(c.value)) throw new ValidationError(`Operator "${c.op}" on ${field} takes a single value; use "in" for lists.`);
  if (!["eq", "ne", "gt", "ge", "lt", "le"].includes(c.op)) throw new ValidationError(`Unsupported operator "${String(c.op)}".`);
  return `${field} ${c.op} ${literal(c.value)}`;
}

export function buildFilter(filters: FilterCondition[] = [], timeRange?: TimeRange): string | undefined {
  if (filters.length > LIMITS.maxFilters) throw new ValidationError(`At most ${LIMITS.maxFilters} filter conditions.`);
  const parts = filters.map(conditionToFilter);
  if (timeRange) {
    const field = assertIdentifier(timeRange.field, "Time field");
    if (!timeRange.from && !timeRange.to) throw new ValidationError("timeRange needs 'from', 'to' or both.");
    if (timeRange.from) parts.push(`${field} ge ${dateTimeLiteral(timeRange.from, "timeRange.from")}`);
    if (timeRange.to) parts.push(`${field} le ${dateTimeLiteral(timeRange.to, "timeRange.to")}`);
    if (timeRange.from && timeRange.to && new Date(timeRange.from) > new Date(timeRange.to)) {
      throw new ValidationError("timeRange.from is after timeRange.to.");
    }
  }
  return parts.length ? parts.join(" and ") : undefined;
}

/**
 * Build the query string. `top` is requested as top+1 so the caller can tell
 * whether more rows exist without relying on $inlinecount support.
 */
export function buildQueryString(opts: QueryOptions): string {
  if (opts.select.length === 0) throw new ValidationError("Select at least one field.");
  if (opts.select.length > LIMITS.maxSelect) throw new ValidationError(`At most ${LIMITS.maxSelect} fields in select.`);
  const select = [...new Set(opts.select.map((s) => assertIdentifier(s, "Select field")))];
  if (!Number.isInteger(opts.top) || opts.top < 1) throw new ValidationError("top must be a positive integer.");
  const skip = opts.skip ?? 0;
  if (!Number.isInteger(skip) || skip < 0) throw new ValidationError("skip must be a non-negative integer.");

  const params: string[] = [`$select=${encodeURIComponent(select.join(","))}`];
  const filter = buildFilter(opts.filters, opts.timeRange);
  if (filter) params.push(`$filter=${encodeURIComponent(filter)}`);
  params.push(`$top=${opts.top + 1}`);
  if (skip > 0) params.push(`$skip=${skip}`);
  params.push("$format=json");
  return `?${params.join("&")}`;
}

const ODATA_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** Convert OData V2 "/Date(ms)/" strings to ISO and drop __metadata blocks. */
export function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "__metadata") continue;
    if (typeof v === "string") {
      const m = ODATA_DATE.exec(v);
      out[k] = m ? new Date(Number(m[1])).toISOString() : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Extract rows from an OData V2 JSON payload: { d: { results: [...] } } or { d: [...] }. */
export function extractRows(payload: unknown): Record<string, unknown>[] {
  const d = (payload as { d?: unknown } | null)?.d;
  const results = Array.isArray(d) ? d : (d as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) throw new Error("Unexpected OData response shape (no d.results array).");
  return results.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null).map(cleanRow);
}

export interface PagedResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  hasMore: boolean;
  nextSkip?: number;
  truncatedForSize?: boolean;
}

/** Apply the top+1 trick and a character budget so responses stay within model context. */
export function pageResult(
  rows: Record<string, unknown>[],
  top: number,
  skip: number,
  maxChars: number,
): PagedResult {
  const hasMore = rows.length > top;
  let page = rows.slice(0, top);
  let truncatedForSize = false;
  while (page.length > 1 && JSON.stringify(page).length > maxChars) {
    page = page.slice(0, Math.max(1, Math.floor(page.length / 2)));
    truncatedForSize = true;
  }
  const more = hasMore || truncatedForSize;
  return {
    rows: page,
    rowCount: page.length,
    hasMore: more,
    ...(more ? { nextSkip: skip + page.length } : {}),
    ...(truncatedForSize ? { truncatedForSize } : {}),
  };
}
