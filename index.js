import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";
import { randomUUID, randomBytes } from "crypto";
import { URL } from "url";
import { registerTools } from "./tools.js";

if (!process.env.ICLOSED_API_KEY) {
  console.error("ICLOSED_API_KEY env var required");
  process.exit(1);
}

// ── OAuth 2.1 (minimal, for claude.ai connector compatibility) ───────

const authCodes = new Map();
const accessTokens = new Set();

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function createMcpServer() {
  const server = new McpServer({ name: "iclosed", version: "2.0.0" });
  registerTools(server);
  return server;
}

// ── HTTP server ──────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

const httpServer = createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // OAuth metadata (RFC 8414)
  if (pathname === "/.well-known/oauth-authorization-server") {
    const base = getBaseUrl(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`, response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"], token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    }));
    return;
  }

  // Dynamic client registration (RFC 7591)
  if (pathname === "/register" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      client_id: randomUUID(), client_name: body.client_name || "claude",
      redirect_uris: body.redirect_uris || [], grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    }));
    return;
  }

  // Authorization endpoint — auto-approve
  if (pathname === "/authorize" && req.method === "GET") {
    const clientId = parsedUrl.searchParams.get("client_id") || "";
    const redirectUri = parsedUrl.searchParams.get("redirect_uri") || "";
    const state = parsedUrl.searchParams.get("state") || "";
    const code = randomBytes(20).toString("hex");
    authCodes.set(code, { clientId, redirectUri, expiresAt: Date.now() + 300_000 });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
    return;
  }

  // Token endpoint
  if (pathname === "/token" && req.method === "POST") {
    const body = new URLSearchParams(await readBody(req));
    const code = body.get("code");
    if (body.get("grant_type") === "authorization_code" && code && authCodes.has(code)) {
      const entry = authCodes.get(code);
      authCodes.delete(code);
      if (Date.now() > entry.expiresAt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "code expired" }));
        return;
      }
      const token = randomBytes(32).toString("hex");
      accessTokens.add(token);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 86400 }));
      return;
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant" }));
    return;
  }

  // MCP endpoint
  if (pathname === "/mcp" || pathname === "/") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");
    if (!accessTokens.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`iClosed MCP server listening on port ${PORT}`);
});
