// Shared tool registration for both stdio and HTTP transports
import { z } from "zod";

// ── generic request helper ──────────────────────────────────────────

export async function iclosedRequest(method, path, { query, body } = {}) {
  const url = new URL(`https://public.api.iclosed.io${path}`);
  if (query) for (const [k, v] of Object.entries(query)) { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); }
  const opts = { method, headers: { Authorization: `Bearer ${process.env.ICLOSED_API_KEY}`, "Content-Type": "application/json" } };
  if (body && (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE")) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ── legacy helpers for computed/analytics tools ─────────────────────

async function fetchAllCalls(eventType = "PAST") {
  const calls = [];
  let page = 0;
  const limit = 100;
  while (true) {
    const json = await iclosedRequest("GET", "/v1/eventCalls", { query: { eventType, limit, page } });
    const batch = json.data?.eventCalls || [];
    calls.push(...batch);
    if (batch.length < limit) break;
    page++;
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
  return { name, email, phone, callDate, outcome, noSaleReason, contactId: call.contactId, eventId: call.id, eventType: call.eventType, answers };
}

function dedupeContacts(calls) {
  const byEmail = new Map();
  const phoneToEmail = new Map();
  for (const call of calls) {
    const c = extractContactFields(call);
    if (!c.email) continue;
    let canonicalEmail = c.email;
    if (c.phone && phoneToEmail.has(c.phone)) canonicalEmail = phoneToEmail.get(c.phone);
    else if (c.phone) phoneToEmail.set(c.phone, c.email);
    const existing = byEmail.get(canonicalEmail);
    if (!existing || new Date(c.callDate) > new Date(existing.lastCallDate)) {
      byEmail.set(canonicalEmail, {
        name: c.name, email: canonicalEmail, phone: c.phone || existing?.phone,
        lastCallDate: c.callDate, outcome: c.outcome, noSaleReason: c.noSaleReason,
        contactId: c.contactId, answers: { ...existing?.answers, ...c.answers },
        totalCalls: (existing?.totalCalls || 0) + 1,
        callHistory: [...(existing?.callHistory || []), { date: c.callDate, outcome: c.outcome, noSaleReason: c.noSaleReason, eventId: c.eventId }],
      });
    } else {
      existing.totalCalls = (existing.totalCalls || 1) + 1;
      existing.callHistory.push({ date: c.callDate, outcome: c.outcome, noSaleReason: c.noSaleReason, eventId: c.eventId });
    }
  }
  return [...byEmail.values()].sort((a, b) => new Date(b.lastCallDate) - new Date(a.lastCallDate));
}

function bucketByPeriod(calls, period) {
  const buckets = {};
  for (const call of calls) {
    const d = new Date(call.dateTimeUTC || call.dateTime);
    let key;
    if (period === "daily") key = d.toISOString().slice(0, 10);
    else if (period === "weekly") { const sun = new Date(d); sun.setDate(d.getDate() - d.getDay()); key = `week-of-${sun.toISOString().slice(0, 10)}`; }
    else key = d.toISOString().slice(0, 7);
    if (!buckets[key]) buckets[key] = { period: key, total: 0, outcomes: {} };
    buckets[key].total++;
    const outcome = (call.task?.[0]?.outcome || "UNKNOWN");
    buckets[key].outcomes[outcome] = (buckets[key].outcomes[outcome] || 0) + 1;
  }
  return Object.values(buckets).sort((a, b) => b.period.localeCompare(a.period));
}

function jsonContent(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// ── register all tools on a server instance ─────────────────────────

export function registerTools(server) {

  // CONTACTS
  server.tool("list_contacts", "List contacts from iClosed with pagination, filtering by status/event/user, and search.", {
    userId: z.number().optional().describe("Filter by user (closer) ID"),
    statuses: z.string().optional().describe("Comma-separated statuses to filter"),
    eventIds: z.string().optional().describe("Comma-separated event IDs to filter"),
    search: z.string().optional().describe("Search term for name/email/phone"),
    limit: z.number().optional().describe("Page size (default 20)"),
    page: z.number().optional().describe("Page number (default 0)"),
    timeFrom: z.string().optional().describe("ISO datetime lower bound"),
    timeTo: z.string().optional().describe("ISO datetime upper bound"),
    orderBy: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
    orderColumn: z.string().optional().describe("Column to sort by"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/contacts", { query: params })); });

  server.tool("create_contact", "Create a new contact in iClosed.", {
    firstName: z.string().optional().describe("First name"), lastName: z.string().optional().describe("Last name"),
    email: z.string().optional().describe("Email address"), phoneNumber: z.string().optional().describe("Phone number"),
    status: z.enum(["POTENTIAL", "QUALIFIED", "DISQUALIFIED"]).optional().describe("Contact status"),
    tag: z.string().optional().describe("Tag to assign"), joinedTime: z.string().optional().describe("ISO datetime when they joined"),
    linkPrefix: z.string().optional().describe("Event link prefix"), utm: z.string().optional().describe("UTM parameters"),
    country: z.string().optional().describe("Country"), timeZone: z.string().optional().describe("Timezone string"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/contacts", { body: params })); });

  server.tool("update_contact", "Update an existing contact in iClosed.", {
    id: z.number().describe("Contact ID (required)"), firstName: z.string().optional().describe("First name"),
    lastName: z.string().optional().describe("Last name"), email: z.string().optional().describe("Email"),
    secondary_email: z.string().optional().describe("Secondary email"), phoneNumber: z.string().optional().describe("Phone number"),
    secondary_phoneNumber: z.string().optional().describe("Secondary phone number"),
    status: z.enum(["POTENTIAL", "QUALIFIED", "DISQUALIFIED"]).optional().describe("Contact status"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/contacts", { body: params })); });

  server.tool("get_contact_detail", "Get detailed info for a single contact by ID.", {
    contactId: z.number().describe("Contact ID (required)"), includeUtms: z.boolean().optional().describe("Include UTM data"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/contacts/detail", { query: params })); });

  server.tool("get_contact_journey", "Get the journey/timeline for a contact.", {
    contactId: z.number().describe("Contact ID (required)"), page: z.number().optional().describe("Page number"),
    limit: z.number().optional().describe("Page size"), userId: z.number().optional().describe("Filter by user ID"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/contacts/journey", { query: params })); });

  server.tool("get_contact_notes", "Get notes for a contact.", {
    contactId: z.number().describe("Contact ID (required)"), limit: z.number().optional().describe("Page size"), page: z.number().optional().describe("Page number"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/contacts/notes", { query: params })); });

  server.tool("create_contact_note", "Add a note to a contact.", {
    contactId: z.number().describe("Contact ID (required)"), note: z.string().describe("Note text (required)"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/contacts/notes", { body: params })); });

  // DEALS
  server.tool("list_deals", "List deals from iClosed with filtering and pagination.", {
    contactId: z.number().optional().describe("Filter by contact ID"), userIds: z.string().optional().describe("Comma-separated user IDs"),
    productIds: z.string().optional().describe("Comma-separated product IDs"),
    transactionType: z.enum(["WON", "RECURRING", "DEPOSIT"]).optional().describe("Transaction type filter"),
    contactStatuses: z.string().optional().describe("Comma-separated contact statuses"), eventIds: z.string().optional().describe("Comma-separated event IDs"),
    search: z.string().optional().describe("Search term"), limit: z.number().optional().describe("Page size"), page: z.number().optional().describe("Page number"),
    orderBy: z.enum(["asc", "desc"]).optional().describe("Sort direction"), orderColumn: z.string().optional().describe("Column to sort by"),
    timeFrom: z.string().optional().describe("ISO datetime lower bound"), timeTo: z.string().optional().describe("ISO datetime upper bound"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/deals", { query: params })); });

  server.tool("create_deal", "Create a new deal in iClosed.", {
    eventCallId: z.number().optional().describe("Associated call ID"), productId: z.number().optional().describe("Product ID"),
    productName: z.string().optional().describe("Product name (if no productId)"), value: z.number().optional().describe("Deal value"),
    time: z.string().optional().describe("ISO datetime of the deal"),
    transactionType: z.enum(["WON", "RECURRING", "DEPOSIT"]).optional().describe("Transaction type"),
    transactionIds: z.array(z.number()).optional().describe("Associated transaction IDs"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/deals", { body: params })); });

  server.tool("update_deal", "Update an existing deal.", {
    id: z.number().describe("Deal ID (required)"), value: z.number().optional().describe("Deal value"),
    recurring: z.boolean().optional().describe("Is recurring"),
    transactionType: z.enum(["WON", "RECURRING", "DEPOSIT"]).optional().describe("Transaction type"),
    productId: z.number().optional().describe("Product ID"), closerId: z.number().optional().describe("Closer user ID"),
    time: z.string().optional().describe("ISO datetime"), transactionIds: z.array(z.number()).optional().describe("Associated transaction IDs"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/deals", { body: params })); });

  // CALLS
  server.tool("list_calls", "List calls (eventCalls) from iClosed with extensive filtering.", {
    ids: z.string().optional().describe("Comma-separated call IDs"), contactId: z.number().optional().describe("Filter by contact ID"),
    eventType: z.enum(["PAST", "UPCOMING", "ALL"]).optional().describe("Event type filter"),
    search: z.string().optional().describe("Search term"), dateFrom: z.string().optional().describe("Date from (ISO)"),
    dateTo: z.string().optional().describe("Date to (ISO)"), createdAtStart: z.string().optional().describe("Created at start (ISO)"),
    createdAtEnd: z.string().optional().describe("Created at end (ISO)"), location: z.string().optional().describe("Location filter"),
    orderColumn: z.string().optional().describe("Column to sort by"), orderBy: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
    limit: z.number().optional().describe("Page size"), page: z.number().optional().describe("Page number"),
    userIds: z.string().optional().describe("Comma-separated user IDs"), eventIds: z.string().optional().describe("Comma-separated event IDs"),
    types: z.string().optional().describe("Comma-separated call types"), inviteeEmails: z.string().optional().describe("Comma-separated invitee emails"),
    outcomes: z.string().optional().describe("Comma-separated outcomes"), noSaleReason: z.string().optional().describe("No-sale reason filter"),
    utmKeys: z.string().optional().describe("UTM keys filter"), utmValues: z.string().optional().describe("UTM values filter"),
    callTypes: z.string().optional().describe("Call types filter"), setterIds: z.string().optional().describe("Comma-separated setter IDs"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/eventCalls", { query: params })); });

  server.tool("create_call", "Create/schedule a new call in iClosed.", {
    contactId: z.number().optional().describe("Existing contact ID"), email: z.string().optional().describe("Invitee email"),
    phoneNumber: z.string().optional().describe("Invitee phone"), firstName: z.string().optional().describe("Invitee first name"),
    lastName: z.string().optional().describe("Invitee last name"), eventId: z.number().optional().describe("Event ID to schedule under"),
    linkPrefix: z.string().optional().describe("Event link prefix"), dateTime: z.string().describe("Call date/time (ISO, required)"),
    timeZone: z.string().describe("Timezone string (required)"), notes: z.string().optional().describe("Notes for the call"),
    additionalGuests: z.string().optional().describe("Additional guest emails"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/eventCalls", { body: params })); });

  server.tool("cancel_call", "Cancel an existing call.", {
    id: z.number().describe("Call ID (required)"), cancelReason: z.string().optional().describe("Reason for cancellation"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/eventCalls/cancel", { body: params })); });

  server.tool("mark_slot_free", "Mark a call slot as free or occupied.", {
    id: z.number().describe("Call ID (required)"), isSlotFree: z.boolean().describe("Whether the slot should be marked free (required)"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/eventCalls/markSlotFree", { body: params })); });

  server.tool("reschedule_call", "Reschedule an existing call to a new date/time.", {
    id: z.number().describe("Call ID (required)"), dateTime: z.string().describe("New date/time (ISO, required)"),
    timeZone: z.string().describe("Timezone (required)"), rescheduleReason: z.string().optional().describe("Reason for rescheduling"),
    notes: z.string().optional().describe("Updated notes"), userId: z.number().optional().describe("Reassign to a different user/closer"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/eventCalls/reschedule", { body: params })); });

  // EVENTS
  server.tool("list_events", "List events (calendar types) in iClosed.", {
    limit: z.number().optional().describe("Page size"), page: z.number().optional().describe("Page number"),
    search: z.string().optional().describe("Search term"), userId: z.number().optional().describe("Filter by user ID"),
    eventType: z.enum(["STRATEGY_EVENT", "DISCOVERY_EVENT"]).optional().describe("Event type filter"),
    latestFirst: z.boolean().optional().describe("Sort latest first"), sort: z.string().optional().describe("Sort field"),
    showFeatureStatuses: z.boolean().optional().describe("Include feature statuses"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/events", { query: params })); });

  server.tool("get_event_detail", "Get detailed info for a single event.", {
    id: z.number().optional().describe("Event ID"), linkPrefix: z.string().optional().describe("Event link prefix"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/events/detail", { query: params })); });

  server.tool("get_event_dates", "Get available dates for an event (booking page).", {
    linkPrefix: z.string().describe("Event link prefix (required)"), timeZone: z.string().optional().describe("Timezone for available slots"),
    currentDate: z.string().optional().describe("Current date (ISO)"), conditionalUsers: z.string().optional().describe("Conditional user IDs"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/events/eventDates", { body: params })); });

  server.tool("update_event_status", "Activate or deactivate an event.", {
    id: z.number().describe("Event ID (required)"), status: z.enum(["ACTIVATED", "DEACTIVATED"]).describe("New status (required)"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/events/status", { body: params })); });

  server.tool("troubleshoot_slots", "Troubleshoot why no slots are available for an event on a given date.", {
    linkPrefix: z.string().describe("Event link prefix (required)"), date: z.string().describe("Date to check (ISO, required)"),
    timezone: z.string().describe("Timezone (required)"), selectedHost: z.number().optional().describe("Specific host user ID"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/events/troubleshootSlots", { query: params })); });

  // FIELDS
  server.tool("create_field", "Create a custom field in iClosed.", {
    name: z.string().describe("Field name (required)"), identifier: z.string().optional().describe("Field identifier/slug"),
    description: z.string().optional().describe("Field description"), inputType: z.string().optional().describe("Input type (TEXT, NUMBER, SELECT, etc.)"),
    type: z.enum(["CONTACT", "CALL", "EVENT", "DEAL", "USER", "ISCORE"]).optional().describe("Object type this field belongs to"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/fields", { body: params })); });

  server.tool("update_field", "Update a custom field.", {
    id: z.number().describe("Field ID (required)"), name: z.string().optional().describe("New name"),
    identifier: z.string().optional().describe("New identifier"), description: z.string().optional().describe("New description"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/fields", { body: params })); });

  server.tool("upsert_field_answer", "Create or update a field answer for a contact or call.", {
    customFieldId: z.number().optional().describe("Custom field ID"), identifier: z.string().optional().describe("Field identifier (alternative to customFieldId)"),
    answer: z.array(z.string()).optional().describe("Answer value(s)"),
    contactId: z.number().optional().describe("Contact ID to set the answer for"), eventCallId: z.number().optional().describe("Call ID to set the answer for"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/fields/answer", { body: params })); });

  server.tool("bulk_upsert_field_answers", "Bulk create/update field answers for multiple contacts.", {
    customFieldId: z.number().optional().describe("Custom field ID"), identifier: z.string().optional().describe("Field identifier"),
    answer: z.array(z.string()).optional().describe("Answer value(s)"),
    contactIds: z.array(z.number()).describe("Contact IDs to set the answer for (required)"),
    overrideExisting: z.boolean().optional().describe("Override existing answers"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/fields/answer/bulk", { body: params })); });

  server.tool("get_contact_stages", "Get the list of contact stages (pipeline stages).", {}, async () => {
    return jsonContent(await iclosedRequest("GET", "/v1/fields/contact-stage"));
  });

  server.tool("insert_invitee_answers", "Insert answers from an invitee booking form.", {
    linkPrefix: z.string().describe("Event link prefix (required)"), contactId: z.number().optional().describe("Contact ID"),
    previewId: z.string().optional().describe("Preview ID"),
    inviteeQuestionAnswers: z.array(z.object({ questionId: z.number().optional(), answer: z.array(z.string()).optional() })).describe("Array of question/answer pairs (required)"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/fields/inviteeAnswers", { body: params })); });

  server.tool("get_fields", "Get custom fields for a specific object type.", {
    objectType: z.enum(["CONTACT", "CALL", "EVENT", "DEAL", "USER", "ISCORE"]).describe("Object type (required)"),
    page: z.number().optional().describe("Page number"), limit: z.number().optional().describe("Page size"),
    search: z.string().optional().describe("Search term"), inputType: z.string().optional().describe("Filter by input type"),
    showSystemFields: z.boolean().optional().describe("Include system fields"), inviteeQuestions: z.boolean().optional().describe("Include invitee questions"),
    identifiers: z.string().optional().describe("Comma-separated identifiers"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/fields/objects", { query: params })); });

  server.tool("get_all_fields", "Get all custom fields across all object types.", {
    page: z.number().optional().describe("Page number"), limit: z.number().optional().describe("Page size"),
    search: z.string().optional().describe("Search term"), inputType: z.string().optional().describe("Filter by input type"),
    showSystemFields: z.boolean().optional().describe("Include system fields"), inviteeQuestions: z.boolean().optional().describe("Include invitee questions"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/fields/objects/all", { query: params })); });

  // OUTCOMES
  server.tool("upsert_outcome", "Set or update the outcome of a call (WON, NO_SALE, APPROVED, REJECTED).", {
    outcome: z.enum(["WON", "NO_SALE", "APPROVED", "REJECTED"]).describe("Outcome (required)"),
    noSaleReason: z.string().optional().describe("Reason for no-sale (enum value)"),
    notes: z.string().optional().describe("Outcome notes"), objection: z.string().optional().describe("Objection category (enum value)"),
    newDeal: z.object({ productId: z.number().optional(), productName: z.string().optional(), value: z.number().optional(), transactionType: z.enum(["WON", "RECURRING", "DEPOSIT"]).optional() }).optional().describe("New deal to create with this outcome"),
    eventCallId: z.number().describe("Call ID this outcome is for (required)"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/outcomes", { body: params })); });

  // PRODUCTS
  server.tool("list_products", "List products in iClosed.", {
    search: z.string().optional().describe("Search term"), limit: z.number().optional().describe("Page size"),
    page: z.number().optional().describe("Page number"), orderBy: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
    orderColumn: z.string().optional().describe("Column to sort by"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/products", { query: params })); });

  server.tool("create_product", "Create a new product.", {
    name: z.string().describe("Product name (required)"), description: z.string().optional().describe("Product description"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/products", { body: params })); });

  server.tool("update_product", "Update an existing product.", {
    productId: z.number().describe("Product ID (required)"), name: z.string().optional().describe("New name"), description: z.string().optional().describe("New description"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/products", { body: params })); });

  // TRANSACTIONS
  server.tool("list_transactions", "List transactions (payments) in iClosed.", {
    id: z.number().optional().describe("Filter by transaction ID"), synced: z.boolean().optional().describe("Filter by sync status"),
    search: z.string().optional().describe("Search term"), source: z.string().optional().describe("Payment source filter"),
    timeFrom: z.string().optional().describe("ISO datetime lower bound"), timeTo: z.string().optional().describe("ISO datetime upper bound"),
    page: z.number().optional().describe("Page number"), limit: z.number().optional().describe("Page size"),
    sort: z.string().optional().describe("Sort field"), sortByAmount: z.enum(["asc", "desc"]).optional().describe("Sort by amount direction"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/transactions", { query: params })); });

  server.tool("create_transaction", "Create a new transaction (payment record).", {
    name: z.string().optional().describe("Payer name"), email: z.string().optional().describe("Payer email"),
    phoneNumber: z.string().optional().describe("Payer phone"), description: z.string().optional().describe("Description"),
    value: z.number().describe("Transaction value (required)"), source: z.string().optional().describe("Payment source"),
    updatedBy: z.string().optional().describe("Who created this"),
  }, async (params) => { return jsonContent(await iclosedRequest("POST", "/v1/transactions", { body: params })); });

  server.tool("update_transaction", "Update an existing transaction.", {
    id: z.number().describe("Transaction ID (required)"), name: z.string().optional().describe("Payer name"),
    email: z.string().optional().describe("Payer email"), phoneNumber: z.string().optional().describe("Payer phone"),
    description: z.string().optional().describe("Description"), value: z.number().optional().describe("New value"),
    source: z.string().optional().describe("Payment source"),
  }, async (params) => { return jsonContent(await iclosedRequest("PUT", "/v1/transactions", { body: params })); });

  server.tool("delete_transaction", "Delete a transaction by ID.", {
    id: z.number().describe("Transaction ID (required)"),
  }, async ({ id }) => { return jsonContent(await iclosedRequest("DELETE", "/v1/transactions", { query: { id } })); });

  // USERS
  server.tool("list_users", "List users (closers/setters) in iClosed.", {
    limit: z.number().optional().describe("Page size"), page: z.number().optional().describe("Page number"),
    search: z.string().optional().describe("Search term"), ids: z.string().optional().describe("Comma-separated user IDs"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/users", { query: params })); });

  server.tool("list_user_availabilities", "List user availability schedules.", {
    userId: z.number().optional().describe("Filter by user ID"),
  }, async (params) => { return jsonContent(await iclosedRequest("GET", "/v1/userAvailabilities", { query: params })); });

  // COMPUTED / ANALYTICS
  server.tool("call_volume", "Call volume analytics with daily/weekly/monthly bucketing and outcome breakdown.", {
    period: z.enum(["daily", "weekly", "monthly"]).describe("Aggregation period"),
    last_n: z.number().optional().describe("Only return the last N periods (default all)"),
  }, async ({ period, last_n }) => {
    const calls = await fetchAllCalls("PAST");
    let buckets = bucketByPeriod(calls, period);
    if (last_n) buckets = buckets.slice(0, last_n);
    const totalCalls = buckets.reduce((s, b) => s + b.total, 0);
    return jsonContent({ period, totalPeriods: buckets.length, totalCalls, buckets });
  });

  server.tool("outcome_summary", "Totals by outcome (WON, NO_SALE, etc.) plus no-sale reason breakdown.", {}, async () => {
    const calls = await fetchAllCalls("PAST");
    const outcomes = {};
    const noSaleReasons = {};
    for (const call of calls) {
      const o = call.task?.[0]?.outcome || "UNKNOWN";
      outcomes[o] = (outcomes[o] || 0) + 1;
      if (o === "NO_SALE") { const r = call.task?.[0]?.noSaleReason || "UNKNOWN"; noSaleReasons[r] = (noSaleReasons[r] || 0) + 1; }
    }
    return jsonContent({ totalCalls: calls.length, outcomes, noSaleReasons });
  });

  server.tool("search_contacts_fuzzy", "Search deduped contacts by name, email, phone, or answer content.", {
    query: z.string().describe("Search term"), limit: z.number().optional().describe("Max results (default 20)"),
  }, async ({ query, limit }) => {
    const calls = await fetchAllCalls("PAST");
    const contacts = dedupeContacts(calls);
    const q = query.toLowerCase();
    const max = limit || 20;
    const results = contacts.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true;
      if (c.email.includes(q)) return true;
      if (c.phone?.includes(q)) return true;
      for (const val of Object.values(c.answers || {})) { if (String(val).toLowerCase().includes(q)) return true; }
      return false;
    }).slice(0, max);
    return jsonContent({ query, count: results.length, results });
  });
}
