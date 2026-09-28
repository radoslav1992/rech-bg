import { Hono } from "hono";
import type { Env } from "./types";
import { origin } from "./security";
import { pageMeta, publicPages, SITE_NAME } from "../shared/seo";
/** Crawler files and the SPA document with per-page metadata. */
export const pages = new Hono<{ Bindings: Env }>();
pages.get("/robots.txt", (c) =>
  c.text(
    "User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api\nDisallow: /reset\nDisallow: /verify\n" +
      `Sitemap: ${origin(c.env, c.req.raw)}/sitemap.xml\n`,
  ),
);
pages.get("/sitemap.xml", (c) => {
  const base = origin(c.env, c.req.raw);
  const urls = Object.keys(publicPages)
    .map((path) => `<url><loc>${base}${path === "/" ? "/" : path}</loc></url>`)
    .join("");
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    200,
    { "Content-Type": "application/xml; charset=utf-8" },
  );
});
const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
pages.get("*", async (c) => {
  const meta = pageMeta(c.req.path);
  const r = await c.env.ASSETS.fetch(c.req.raw);
  if (!r.headers.get("content-type")?.includes("text/html")) return r;
  const url = origin(c.env, c.req.raw) + (meta.route || c.req.path);
  const result = new HTMLRewriter()
    .on("title", {
      element(el) {
        el.setInnerContent(meta.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute("content", meta.description);
      },
    })
    .on("head", {
      element(el) {
        el.append(
          meta.indexable
            ? [
                `<link rel="canonical" href="${escapeAttr(url)}">`,
                `<meta property="og:type" content="website">`,
                `<meta property="og:locale" content="bg_BG">`,
                `<meta property="og:site_name" content="${SITE_NAME}">`,
                `<meta property="og:title" content="${escapeAttr(meta.title)}">`,
                `<meta property="og:description" content="${escapeAttr(meta.description)}">`,
                `<meta property="og:url" content="${escapeAttr(url)}">`,
                `<meta name="twitter:card" content="summary">`,
              ].join("")
            : '<meta name="robots" content="noindex,nofollow">',
          { html: true },
        );
      },
    })
    .transform(r);
  // Unknown paths still render the SPA's not-found page, but with a real 404 status for crawlers.
  return meta.route
    ? result
    : new Response(result.body, { status: 404, headers: result.headers });
});
