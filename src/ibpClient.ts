import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import type { AppConfig } from "./config.js";

export class IbpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IbpError";
  }
}

const HINTS: Record<number, string> = {
  401: "Authentication failed. Check the communication user and password in the BTP destination.",
  403: "Access denied. Check that the communication arrangement for SAP_COM_0720 is active and that the planning area / master data type is exposed in Global Configuration (FLEXQUERY PLANNINGAREA / RELEVANT_MDT_FOR_MD_API).",
  404: "Not found. The planning area or master data type is probably not exposed for this service, or the name is wrong. Use ibp_list_entities to see what is available.",
  429: "IBP is throttling requests. Wait a moment and retry with a smaller page.",
};

/** Pull the human-readable message out of an OData V2 error body, never the raw response. */
function odataMessage(data: unknown): string | undefined {
  if (typeof data === "string") {
    const m = /<message[^>]*>([^<]{1,500})<\/message>/i.exec(data);
    return m?.[1];
  }
  const v = (data as { error?: { message?: { value?: unknown } | string } } | undefined)?.error?.message;
  if (typeof v === "string") return v.slice(0, 500);
  if (v && typeof v.value === "string") return v.value.slice(0, 500);
  return undefined;
}

function toIbpError(err: unknown): IbpError {
  // Cloud SDK wraps the axios error; the HTTP response lives on `cause`.
  const e = err as { message?: string; cause?: { response?: { status?: number; data?: unknown }; code?: string } };
  const response = e?.cause?.response;
  const status = response?.status;
  if (status) {
    const detail = odataMessage(response?.data);
    const hint = HINTS[status] ?? (status >= 500 ? "IBP returned a server error. Retry later or narrow the query." : "");
    return new IbpError(`IBP returned HTTP ${status}.${detail ? ` IBP says: ${detail}.` : ""} ${hint}`.trim(), status);
  }
  const code = e?.cause?.code;
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") {
    return new IbpError("The request to IBP timed out. Narrow the time range or reduce 'top'.");
  }
  const msg = e?.message ?? String(err);
  if (/destination/i.test(msg)) {
    return new IbpError(`Could not resolve the BTP destination: ${msg}`);
  }
  return new IbpError(`Could not reach IBP: ${msg}`);
}

export class IbpClient {
  constructor(private readonly cfg: AppConfig) {}

  /** Read-only GET through the BTP destination. The only HTTP method this server ever sends. */
  async get(path: string, accept: "application/json" | "application/xml"): Promise<unknown> {
    try {
      const response = await executeHttpRequest(
        { destinationName: this.cfg.destinationName, useCache: true },
        {
          method: "get",
          url: path,
          headers: { Accept: accept },
          timeout: this.cfg.requestTimeoutMs,
          responseType: accept === "application/xml" ? "text" : "json",
        },
        { fetchCsrfToken: false },
      );
      return response.data;
    } catch (err) {
      throw toIbpError(err);
    }
  }
}
