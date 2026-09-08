import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "http";
import { randomUUID, randomBytes } from "crypto";
import { URL } from "url";

const ICLOSED_API_KEY = process.env.ICLOSED_API_KEY;
const ICLOSED_BASE = "https://public.api.iclosed.io/v1";
const MCP_SECRET = process.env.MCP_SECRET || "";

if (!ICLOSED_API_KEY) {
  console.error("ICLOSED_API_KEY env var required");
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────

async function iclosedFetch(path) {
  const res = await fetch(`${ICLOSED_BASE}${path}`, {
    headers: { Authorization: `Bearer ${ICLOSED_API_KEY}` },
  });
  if (!res.ok) throw new Error(`iClosed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchAllCalls(eventType = "PAST") {
  const calls = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const json = await iclosedFetch(
      `/eventCalls?eventType=${eventType}&limit=${limit}&offset=${offset}`
    );
    const batch = json.data?.eventCalls || [];
    calls.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return calls;
}

function extractContactFields(call) {
  const email = (call.inviteeEmail || "").toLowerCase().trim();
  const name = (call.inviteeName || "").trim();
  const phone = call.phoneNumber || null;
  const callDate = call.dateTimeUTC || call.dateTime;
  const tasks = call.task || [];
  const outcome = tasks[0]?.outcome || null;
  const noSaleReason = tasks[0]?.noSaleReason || null;

  const answers = {};
  for (const sa of call.secondaryAnswers || []) {
    const stmt = (sa.statement || "").trim();
    const val = sa.answer?.[0]?.answer || null;
    if (stmt && val) answers[stmt] = val;
  }

  return {
    name,
    email,
    phone,
    callDate,
    outcome,
    noSaleReason,
    contactId: call.contactId,
    eventId: call.id,
    eventType: call.eventType,
    answers,
  };
}

function dedupeContacts(calls) {
  const byEmail = new Map();
  const phoneToEmail = new Map();

  for (const call of calls) {
    const c = extractContactFields(call);
    if (!c.email) continue;

    let canonicalEmail = c.email;
    if (c.phone && phoneToEmail.has(c.phone)) {
      canonicalEmail = phoneToEmail.get(c.phone);
    } else if (c.phone) {
      phoneToEmail.set(c.phone, c.email);
    }

    const existing = byEmail.get(canonicalEmail);
    if (!existing || new Date(c.callDate) > new Date(existing.lastCallDate)) {
      byEmail.set(canonicalEmail, {
        name: c.name,
        email: canonicalEmail,
        phone: c.phone || existing?.phone,
        lastCallDate: c.callDate,
        outcome: c.outcome,
        noSaleReason: c.noSaleReason,
        contactId: c.contactId,
        answers: { ...existing?.answers, ...c.answers },
        totalCalls: (existing?.totalCalls || 0) + 1,
        callHistory: [...(existing?.callHistory || []), {
          date: c.callDate,
          outcome: c.outcome,
          noSaleReason: c.noSaleReason,
          eventId: c.eventId,
        }],
      });
    } else {
      existing.totalCalls = (existing.totalCalls || 1) + 1;
      existing.callHistory.push({
        date: c.callDate,
        outcome: c.outcome,
        noSaleReason: c.noSaleReason,
        eventId: c.eventId,
      });
    }
  }

  return [...byEmail.values()].sort(
    (a, b) => new Date(b.lastCallDate) - new Date(a.lastCallDate)
  );
}

function bucketByPeriod(calls, period) {
  const buckets = {};
  for (const call of calls) {
    const d = new Date(call.dateTimeUTC || call.dateTime);
    let key;
    if (period === "daily") key = d.toISOString().slice(0, 10);
    else if (period === "weekly") {
      const sun = new Date(d);
      sun.setDate(d.getDate() - d.getDay());
      key = `week-of-${sun.toISOString().slice(0, 10)}`;
    } else {
      key = d.toISOString().slice(0, 7);
    }
    if (!buckets[key]) buckets[key] = { period: key, total: 0, outcomes: {} };
    buckets[key].total++;
    const outcome = (call.task?.[0]?.outcome || "UNKNOWN");
    buckets[key].outcomes[outcome] = (buckets[key].outcomes[outcome] || 0) + 1;
  }
  return Object.values(buckets).sort((a, b) => b.period.localeCompare(a.period));
}

// ── MCP server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "iclosed",
  version: "1.0.0",
});

// 1. List all contacts (deduped)
server.tool(
  "list_contacts",
  "List all iClosed contacts with call history, answers, outcome, phone, email. Deduped by email/phone.",
  {
    limit: z.number().optional().describe("Max contacts to return (default all)"),
    outcome_filter: z
      .enum(["SALE", "NO_SALE", "PENDING", "ALL"])
      .optional()
      .describe("Filter by outcome (default ALL)"),
  },
  async ({ limit, outcome_filter }) => {
    const calls = await fetchAllCalls("PAST");
    let contacts = dedupeContacts(calls);
    if (outcome_filter && outcome_filter !== "ALL") {
      contacts = contacts.filter((c) => c.outcome === outcome_filter);
    }
    if (limit) contacts = contacts.slice(0, limit);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: contacts.length, contacts }, null, 2),
        },
      ],
    };
  }
);

// 2. Get single contact by email
server.tool(
  "get_contact",
  "Look up a specific iClosed contact by email. Returns full call history, answers, outcome.",
  {
    email: z.string().describe("Contact email to look up"),
  },
  async ({ email }) => {
    const calls = await fetchAllCalls("PAST");
    const needle = email.toLowerCase().trim();
    const matching = calls.filter(
      (c) => (c.inviteeEmail || "").toLowerCase().trim() === needle
    );
    if (!matching.length) {
      return { content: [{ type: "text", text: `No contact found for ${email}` }] };
    }
    const detailed = matching.map(extractContactFields);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { email: needle, totalCalls: detailed.length, calls: detailed },
            null,
            2
          ),
        },
      ],
    };
  }
);

// 3. Search contacts by name or answer content
server.tool(
  "search_contacts",
  "Search iClosed contacts by name, email, phone, or answer content (case-insensitive substring match).",
  {
    query: z.string().describe("Search term"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, limit }) => {
    const calls = await fetchAllCalls("PAST");
    const contacts = dedupeContacts(calls);
    const q = query.toLowerCase();
    const max = limit || 20;

    const results = contacts.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true;
      if (c.email.includes(q)) return true;
      if (c.phone?.includes(q)) return true;
      for (const val of Object.values(c.answers || {})) {
        if (String(val).toLowerCase().includes(q)) return true;
      }
      return false;
    }).slice(0, max);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ query, count: results.length, results }, null, 2),
        },
      ],
    };
  }
);

// 4. Call volume analytics
server.tool(
  "call_volume",
  "Get call volume analytics — daily, weekly, or monthly. Shows totals and outcome breakdown per period.",
  {
    period: z
      .enum(["daily", "weekly", "monthly"])
      .describe("Aggregation period"),
    last_n: z
      .number()
      .optional()
      .describe("Only return the last N periods (default all)"),
  },
  async ({ period, last_n }) => {
    const calls = await fetchAllCalls("PAST");
    let buckets = bucketByPeriod(calls, period);
    if (last_n) buckets = buckets.slice(0, last_n);
    const totalCalls = buckets.reduce((s, b) => s + b.total, 0);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { period, totalPeriods: buckets.length, totalCalls, buckets },
            null,
            2
          ),
        },
      ],
    };
  }
);

// 5. Outcome summary
server.tool(
  "outcome_summary",
  "Summary of all call outcomes — how many SALE, NO_SALE, PENDING, etc. plus no-sale reason breakdown.",
  {},
  async () => {
    const calls = await fetchAllCalls("PAST");
    const outcomes = {};
    const noSaleReasons = {};
    for (const call of calls) {
      const o = call.task?.[0]?.outcome || "UNKNOWN";
      outcomes[o] = (outcomes[o] || 0) + 1;
      if (o === "NO_SALE") {
        const r = call.task?.[0]?.noSaleReason || "UNKNOWN";
        noSaleReasons[r] = (noSaleReasons[r] || 0) + 1;
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { totalCalls: calls.length, outcomes, noSaleReasons },
            null,
            2
          ),
        },
      ],
    };
  }
);

// 6. Recent calls (raw, most recent first)
server.tool(
  "recent_calls",
  "Get the most recent iClosed calls with full details — invitee name, email, phone, answers, outcome, date.",
  {
    limit: z.number().optional().describe("Number of calls (default 10)"),
    event_type: z
      .enum(["PAST", "UPCOMING"])
      .optional()
      .describe("PAST or UPCOMING calls (default PAST)"),
  },
  async ({ limit, event_type }) => {
    const type = event_type || "PAST";
    const max = limit || 10;
    const calls = await fetchAllCalls(type);
    // sort most recent first
    calls.sort(
      (a, b) =>
        new Date(b.dateTimeUTC || b.dateTime) -
        new Date(a.dateTimeUTC || a.dateTime)
    );
    const recent = calls.slice(0, max).map(extractContactFields);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { eventType: type, count: recent.length, calls: recent },
            null,
            2
          ),
        },
      ],
    };
  }
);

// 7. Upcoming calls
server.tool(
  "upcoming_calls",
  "List all upcoming/scheduled iClosed calls with invitee details and answers.",
  {},
  async () => {
    const calls = await fetchAllCalls("UPCOMING");
    calls.sort(
      (a, b) =>
        new Date(a.dateTimeUTC || a.dateTime) -
        new Date(b.dateTimeUTC || b.dateTime)
    );
    const upcoming = calls.map(extractContactFields);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { count: upcoming.length, calls: upcoming },
            null,
            2
          ),
        },
      ],
    };
  }
);

// 8. Answers breakdown — what people filled in on the booking form
server.tool(
  "answers_breakdown",
  "See all unique booking form answers across all calls — shows what questions were asked and how people answered.",
  {
    question_filter: z
      .string()
      .optional()
      .describe("Filter to a specific question (substring match)"),
  },
  async ({ question_filter }) => {
    const calls = await fetchAllCalls("PAST");
    const questions = {};
    for (const call of calls) {
      for (const sa of call.secondaryAnswers || []) {
        const stmt = (sa.statement || "").trim();
        const val = sa.answer?.[0]?.answer || null;
        if (!stmt || !val) continue;
        if (question_filter && !stmt.toLowerCase().includes(question_filter.toLowerCase())) continue;
        if (!questions[stmt]) questions[stmt] = [];
        questions[stmt].push({
          answer: val,
          email: (call.inviteeEmail || "").toLowerCase().trim(),
          name: (call.inviteeName || "").trim(),
          date: call.dateTimeUTC || call.dateTime,
        });
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { questionCount: Object.keys(questions).length, questions },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── OAuth 2.1 (minimal, for claude.ai connector compatibility) ───────

const authCodes = new Map();   // code -> { clientId, redirectUri, expiresAt }
const accessTokens = new Set(); // valid tokens

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

// ── HTTP transport for remote MCP ────────────────────────────────────

const PORT = process.env.PORT || 3001;

const httpServer = createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // CORS for all routes
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

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
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    }));
    return;
  }

  // Dynamic client registration (RFC 7591)
  if (pathname === "/register" && req.method === "POST") {
    const body = JSON.parse(await readBody(req));
    const clientId = randomUUID();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      client_id: clientId,
      client_name: body.client_name || "claude",
      redirect_uris: body.redirect_uris || [],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    }));
    return;
  }

  // Authorization endpoint — auto-approve, redirect back with code
  if (pathname === "/authorize" && req.method === "GET") {
    const clientId = parsedUrl.searchParams.get("client_id") || "";
    const redirectUri = parsedUrl.searchParams.get("redirect_uri") || "";
    const state = parsedUrl.searchParams.get("state") || "";
    const code = randomBytes(20).toString("hex");

    authCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: parsedUrl.searchParams.get("code_challenge"),
      expiresAt: Date.now() + 300_000, // 5 min
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    if (state) redirect.searchParams.set("state", state);

    res.writeHead(302, { Location: redirect.toString() });
    res.end();
    return;
  }

  // Token endpoint — exchange code for access token
  if (pathname === "/token" && req.method === "POST") {
    const body = new URLSearchParams(await readBody(req));
    const grantType = body.get("grant_type");
    const code = body.get("code");

    if (grantType === "authorization_code" && code && authCodes.has(code)) {
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
      res.end(JSON.stringify({
        access_token: token,
        token_type: "Bearer",
        expires_in: 86400,
      }));
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant" }));
    return;
  }

  // MCP endpoint — check bearer token
  if (pathname === "/mcp" || pathname === "/") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    if (!accessTokens.has(token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`iClosed MCP server listening on port ${PORT}`);
});
