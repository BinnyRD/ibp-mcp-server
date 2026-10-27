import { XMLParser } from "fast-xml-parser";
import type { IbpClient } from "./ibpClient.js";

export interface PropertyInfo {
  name: string;
  type: string;
  label?: string;
  isKey: boolean;
}

export interface EntityInfo {
  entitySet: string;
  entityType: string;
  properties: PropertyInfo[];
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  // Never let a hostile or oversized document expand entities.
  processEntities: false,
});

type Xml = Record<string, any>;

/** Parse an OData V2 $metadata document into entity sets and their properties. */
export function parseMetadata(xml: string): Map<string, EntityInfo> {
  const doc = parser.parse(xml) as Xml;
  const schemas = asArray<Xml>(doc?.Edmx?.DataServices?.Schema);
  if (schemas.length === 0) throw new Error("Could not read $metadata (no Schema element).");

  const types = new Map<string, Xml>();
  for (const schema of schemas) {
    for (const t of asArray<Xml>(schema.EntityType)) types.set(t.Name, t);
  }

  const result = new Map<string, EntityInfo>();
  for (const schema of schemas) {
    for (const container of asArray<Xml>(schema.EntityContainer)) {
      for (const set of asArray<Xml>(container.EntitySet)) {
        const typeName = String(set.EntityType ?? "").split(".").pop() ?? "";
        const type = types.get(typeName);
        if (!type) continue;
        const keys = new Set(asArray<Xml>(type.Key?.PropertyRef).map((k) => k.Name));
        result.set(String(set.Name).toUpperCase(), {
          entitySet: String(set.Name),
          entityType: typeName,
          properties: asArray<Xml>(type.Property).map((p) => ({
            name: String(p.Name),
            type: String(p.Type ?? "").replace(/^Edm\./, ""),
            ...(p.label ? { label: String(p.label) } : {}),
            isKey: keys.has(p.Name),
          })),
        });
      }
    }
  }
  return result;
}

/** Parse the OData V2 JSON service document: { d: { EntitySets: [...] } }. */
export function parseServiceDocument(payload: unknown): string[] {
  const sets = (payload as { d?: { EntitySets?: unknown } } | null)?.d?.EntitySets;
  if (!Array.isArray(sets)) throw new Error("Unexpected service document shape (no d.EntitySets).");
  return sets.filter((s): s is string => typeof s === "string");
}

const TTL_MS = 10 * 60 * 1000;

/** Small TTL cache: $metadata for a planning area can be large and rarely changes. */
export class MetadataCache {
  private cache = new Map<string, { at: number; value: Promise<Map<string, EntityInfo>> }>();

  constructor(private readonly client: IbpClient) {}

  get(servicePath: string): Promise<Map<string, EntityInfo>> {
    const hit = this.cache.get(servicePath);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = this.client
      .get(`${servicePath}/$metadata`, "application/xml")
      .then((xml) => parseMetadata(String(xml)));
    // Do not cache failures.
    value.catch(() => this.cache.delete(servicePath));
    this.cache.set(servicePath, { at: Date.now(), value });
    return value;
  }
}
