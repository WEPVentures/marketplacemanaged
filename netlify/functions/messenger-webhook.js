// Meta Messenger webhook receiver (Netlify Function, v2 syntax, zero dependencies).
//
//   GET  -> answers Meta's webhook verification handshake (hub.mode / hub.verify_token / hub.challenge).
//   POST -> verifies Meta's X-Hub-Signature-256 (HMAC-SHA256 of the RAW body with the app secret), then
//           stores each message / postback / referral event through the public.record_webhook_event() RPC.
//
// Why an RPC and not the Supabase service-role key: this function runs on the website's Netlify project.
// It authenticates to Supabase with the public anon key plus a dedicated ingest secret that the RPC checks,
// so even a leaked env var can do nothing but insert webhook rows (never read or change customer data).
//
// Env vars (Netlify, "Functions" scope, mark the secrets as secret):
//   META_VERIFY_TOKEN, META_APP_SECRET, WEBHOOK_INGEST_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY
//
// Privacy: never log request bodies, message text, PSIDs or attachment URLs (they are bearer URLs). Log counts only.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const text = (status, body = "") => new Response(body, { status, headers: { "content-type": "text/plain" } });

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Keep only events the agent acts on. Skip echoes of our own sends, delivery and read receipts.
function toRows(body) {
  const rows = [];
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      if (!ev || !ev.sender || !ev.sender.id) continue;
      if (ev.message && ev.message.is_echo) continue;
      const type = ev.message ? "message" : ev.postback ? "postback" : ev.referral ? "referral" : null;
      if (!type) continue;
      const mid = (ev.message && ev.message.mid) || (ev.postback && ev.postback.mid) || null;
      const dedupe = mid || createHash("sha256").update(JSON.stringify(ev)).digest("hex");
      rows.push({ dedupe_key: dedupe, psid: String(ev.sender.id), event_type: type, event_ts: ev.timestamp || Date.now(), payload: ev });
    }
  }
  return rows;
}

export default async (request) => {
  const { META_VERIFY_TOKEN, META_APP_SECRET, WEBHOOK_INGEST_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

  if (request.method === "GET") {
    const q = new URL(request.url).searchParams;
    const ok = q.get("hub.mode") === "subscribe" && META_VERIFY_TOKEN && safeEqual(q.get("hub.verify_token") || "", META_VERIFY_TOKEN);
    return ok ? text(200, q.get("hub.challenge") || "") : text(403, "Forbidden");
  }
  if (request.method !== "POST") return text(405, "Method Not Allowed");

  if (!META_APP_SECRET || !WEBHOOK_INGEST_SECRET || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("messenger-webhook: missing env configuration");
    return text(500, "Server not configured");
  }

  const raw = await request.text(); // HMAC must be computed over the exact raw bytes
  const signature = request.headers.get("x-hub-signature-256") || "";
  const expected = "sha256=" + createHmac("sha256", META_APP_SECRET).update(raw).digest("hex");
  if (!safeEqual(signature, expected)) return text(403, "Forbidden");

  let body;
  try { body = JSON.parse(raw); } catch { return text(400, "Bad Request"); }
  if (body.object !== "page") return text(200, "ignored");

  const rows = toRows(body);
  if (rows.length === 0) return text(200, "ok");

  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/record_webhook_event`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ p_secret: WEBHOOK_INGEST_SECRET, p_events: rows }),
  });
  if (!res.ok) {
    console.error(`messenger-webhook: store failed (${res.status})`); // status only, never the body
    return text(500, "Store failed"); // non-2xx makes Meta retry; dedupe_key makes retries safe
  }
  console.log(`messenger-webhook: stored ${rows.length} event(s)`);
  return text(200, "ok");
};
