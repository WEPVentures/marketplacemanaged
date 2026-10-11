import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.META_VERIFY_TOKEN = "verify-token";
process.env.META_APP_SECRET = "app-secret";
process.env.WEBHOOK_INGEST_SECRET = "ingest-secret";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "anon-key";

const { default: handler } = await import("../netlify/functions/messenger-webhook.js");
const URL_BASE = "https://site.test/.netlify/functions/messenger-webhook";
const sign = (raw, secret = "app-secret") => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const post = (raw, sig = sign(raw)) => handler(new Request(URL_BASE, { method: "POST", body: raw, headers: { "x-hub-signature-256": sig } }));

const page = (messaging) => JSON.stringify({ object: "page", entry: [{ id: "PAGE", messaging }] });
const msg = { sender: { id: "PSID1" }, recipient: { id: "PAGE" }, timestamp: 1700000000000, message: { mid: "m1", text: "hi" } };

function mockFetch(status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response("1", { status }); };
  return calls;
}

test("GET verification: correct token echoes the challenge", async () => {
  const res = await handler(new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=12345`));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "12345");
});

test("GET verification: wrong token is rejected", async () => {
  const res = await handler(new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`));
  assert.equal(res.status, 403);
});

test("POST with a bad signature is rejected and nothing is stored", async () => {
  const calls = mockFetch();
  const res = await post(page([msg]), sign(page([msg]), "wrong-secret"));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("POST with a missing signature is rejected", async () => {
  const calls = mockFetch();
  const res = await handler(new Request(URL_BASE, { method: "POST", body: page([msg]) }));
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("POST with a valid signature stores the event via the RPC, using only anon key + ingest secret", async () => {
  const calls = mockFetch();
  const res = await post(page([msg]));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.supabase.co/rest/v1/rpc/record_webhook_event");
  assert.equal(calls[0].init.headers.apikey, "anon-key");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.p_secret, "ingest-secret");
  assert.equal(sent.p_events.length, 1);
  assert.equal(sent.p_events[0].dedupe_key, "m1");
  assert.equal(sent.p_events[0].psid, "PSID1");
  assert.equal(sent.p_events[0].event_type, "message");
  assert.ok(!JSON.stringify(calls[0].init.headers).includes("app-secret"));
});

test("echoes, delivery and read receipts are skipped; postbacks and referrals are kept", async () => {
  const calls = mockFetch();
  const echo = { ...msg, message: { mid: "m2", is_echo: true, text: "bot" } };
  const delivery = { sender: { id: "PSID1" }, recipient: { id: "PAGE" }, delivery: { watermark: 1 } };
  const read = { sender: { id: "PSID1" }, recipient: { id: "PAGE" }, read: { watermark: 1 } };
  const postback = { sender: { id: "PSID1" }, recipient: { id: "PAGE" }, timestamp: 1, postback: { title: "t", payload: "GET_STARTED" } };
  const referral = { sender: { id: "PSID1" }, recipient: { id: "PAGE" }, timestamp: 2, referral: { ref: "site-start" } };
  const res = await post(page([echo, delivery, read, postback, referral]));
  assert.equal(res.status, 200);
  const types = JSON.parse(calls[0].init.body).p_events.map((e) => e.event_type);
  assert.deepEqual(types, ["postback", "referral"]);
});

test("a page payload with only ignorable events makes no Supabase call", async () => {
  const calls = mockFetch();
  const res = await post(page([{ sender: { id: "P" }, recipient: { id: "PAGE" }, delivery: {} }]));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
});

test("a Supabase failure returns 500 so Meta retries", async () => {
  mockFetch(500);
  const res = await post(page([msg]));
  assert.equal(res.status, 500);
});

test("non-page objects are acknowledged and ignored; other methods are rejected", async () => {
  const calls = mockFetch();
  const raw = JSON.stringify({ object: "instagram", entry: [] });
  assert.equal((await post(raw)).status, 200);
  assert.equal(calls.length, 0);
  assert.equal((await handler(new Request(URL_BASE, { method: "PUT" }))).status, 405);
});
