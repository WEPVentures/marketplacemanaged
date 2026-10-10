// Build-time item source.
//   - SUPABASE_URL + SUPABASE_ANON_KEY set -> read active rows from `items`
//     (public RLS policy only exposes status = 'active').
//   - otherwise -> read data/items/*.json (local dev / before Supabase exists).
// A Supabase failure FAILS the build on purpose: Netlify keeps serving the last
// good deploy instead of publishing a site with every item missing.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_ANON_KEY || "";

const photoUrl = (p) =>
  /^https?:\/\//.test(p) || p.startsWith("/") ? p : `${SUPABASE_URL}/storage/v1/object/public/item-photos/${p}`;

function normalize(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    price: Number(row.price),
    condition: row.condition,
    photos: (row.photo_urls || []).map(photoUrl),
    publishedAt: row.published_at || null,
  };
}

async function fromSupabase() {
  const q = "status=eq.active&select=id,title,description,price,condition,photo_urls,published_at&order=published_at.desc";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/items?${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase items fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fromFiles() {
  const dir = path.resolve("data/items");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const rows = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8"))));
  return rows.filter((r) => r.status === "active");
}

export default async function () {
  const rows = SUPABASE_URL && KEY ? await fromSupabase() : await fromFiles();
  console.log(`[items] ${rows.length} active item(s) from ${SUPABASE_URL && KEY ? "Supabase" : "data/items/*.json"}`);
  return rows.map(normalize);
}
