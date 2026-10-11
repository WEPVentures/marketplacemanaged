// Site-wide config. Everything comes from env vars (see .env.example) so the
// same repo works for local dev, Netlify previews, and production.
const url = (process.env.SITE_URL || process.env.URL || "https://marketplacemanaged.com").replace(/\/$/, "");

const pageName = process.env.PAGE_NAME || "MarketplaceManaged";

export default {
  name: "Marketplace. Managed.",
  tagline: "The easiest way to sell on Facebook Marketplace.",
  url,
  // Facebook Page username -> https://m.me/<PAGE_NAME>. Change it by setting PAGE_NAME in Netlify and redeploying.
  pageName,
  // The one conversion link: opens a Messenger thread with us. `ref` lets the bot know where the chat came from.
  startUrl: `https://m.me/${encodeURIComponent(pageName)}?ref=site-start`,
  fee: 5,
};
