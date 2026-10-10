// Site-wide config. Everything comes from env vars (see .env.example) so the
// same repo works for local dev, Netlify previews, and production.
const url = (process.env.SITE_URL || process.env.URL || "https://marketplacemanaged.com").replace(/\/$/, "");

export default {
  name: "Marketplace. Managed.",
  tagline: "The easiest way to sell on Facebook Marketplace.",
  url,
  // The Facebook Page username used in https://m.me/<PAGE_NAME>. Page doesn't exist yet.
  pageName: process.env.PAGE_NAME || "MarketplaceManaged",
  // Public (anon) values only — these ship to the browser. RLS protects the data.
  supabaseUrl: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  fee: 5,
};
