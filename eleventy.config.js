import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // /assets/x.css -> /assets/x.css?v=<content hash>, so a changed file always has a new URL
  eleventyConfig.addFilter("assetVersion", (url) => {
    const hash = createHash("md5").update(readFileSync("src" + url)).digest("hex").slice(0, 8);
    return `${url}?v=${hash}`;
  });
  eleventyConfig.addFilter("money", (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    return "$" + (Number.isInteger(v) ? v : v.toFixed(2));
  });
  eleventyConfig.addFilter("absUrl", (path, base) => new URL(path, base).href);
  eleventyConfig.addFilter("absAll", (list, base) => (list || []).map((p) => new URL(p, base).href));
  eleventyConfig.addFilter("schemaCondition", (c) => {
    const map = { "Like new": "UsedCondition", Good: "UsedCondition", Fair: "UsedCondition", "For parts": "DamagedCondition" };
    return "https://schema.org/" + (map[c] || "UsedCondition");
  });
  eleventyConfig.addFilter("json", (v) => JSON.stringify(v).replace(/</g, "\\u003c"));

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    templateFormats: ["njk", "md"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}
