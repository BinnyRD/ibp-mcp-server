import express from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { buildAuth } from "./auth.js";
import { IbpClient } from "./ibpClient.js";
import { MetadataCache } from "./metadata.js";
import { buildMcpServer } from "./tools.js";

const cfg = loadConfig();
const client = new IbpClient(cfg);
const metadata = new MetadataCache(client);
const auth = buildAuth(cfg);

if (cfg.allowedPlanningAreas.length === 0 && cfg.allowedMasterDataTypes.length === 0) {
  console.warn("[config] No planning areas or master data types are allowed. Every data call will be refused.");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Cloud Foundry router sits in front.
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(
  "/mcp",
  rateLimit({ windowMs: 60_000, limit: cfg.rateLimitPerMinute, standardHeaders: "draft-8", legacyHeaders: false }),
);

// Stateless Streamable HTTP: a fresh server + transport per request. Scales horizontally,
// nothing to leak between users, and no session affinity needed on Cloud Foundry.
app.post("/mcp", auth, async (req, res) => {
  const server = buildMcpServer(cfg, client, metadata);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const methodNotAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const httpServer = app.listen(cfg.port, () => {
  console.log(`[ibp-mcp] listening on :${cfg.port} (auth=${cfg.authMode}, destination=${cfg.destinationName})`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[ibp-mcp] ${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
