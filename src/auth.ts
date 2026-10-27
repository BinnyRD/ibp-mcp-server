import type { RequestHandler } from "express";
import { XsuaaService, createSecurityContext } from "@sap/xssec";
// @sap/xsenv ships without type definitions.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import xsenv from "@sap/xsenv";
import type { AppConfig } from "./config.js";

/**
 * Validates the XSUAA JWT on every request and requires the configured local
 * scope (default "Read" -> $XSAPPNAME.Read). Fails at startup if no XSUAA
 * service is bound, so a misconfigured deployment never runs unprotected.
 */
export function buildAuth(cfg: AppConfig): RequestHandler {
  if (cfg.authMode === "none") {
    console.warn("[auth] AUTH_MODE=none: endpoint is UNPROTECTED. Local development only.");
    return (_req, _res, next) => next();
  }

  let credentials: unknown;
  try {
    credentials = xsenv.getServices({ xsuaa: { tag: "xsuaa" } }).xsuaa;
  } catch {
    throw new Error("No XSUAA service bound. Bind one (see README) or set AUTH_MODE=none for local development.");
  }
  const service = new XsuaaService(credentials as ConstructorParameters<typeof XsuaaService>[0]);

  return async (req, res, next) => {
    try {
      const ctx = await createSecurityContext(service, { req });
      if (!ctx.checkLocalScope(cfg.requiredScope)) {
        res.status(403).json({ error: "forbidden", message: `Missing scope ${cfg.requiredScope}.` });
        return;
      }
      next();
    } catch {
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="ibp-mcp"')
        .json({ error: "unauthorized", message: "A valid XSUAA bearer token is required." });
    }
  };
}
