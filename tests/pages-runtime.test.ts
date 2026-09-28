import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { publicPages } from "../shared/seo";

// HTMLRewriter only exists in workerd, so the page routes run in the real runtime with a stub asset server.
describe("SPA document and crawler files in the Cloudflare runtime", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `import { pages } from './server/pages';
          const html = '<!doctype html><html><head><meta name="description" content="default"><title>default</title></head><body><div id="root"></div></body></html>';
          const ASSETS = { fetch: async (request) => new URL(request.url).pathname.endsWith('.js')
            ? new Response('export {}', { headers: { 'content-type': 'text/javascript' } })
            : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) };
          export default { fetch: (request, env, ctx) => pages.fetch(request, { SITE_URL: 'https://rechbg.com', ASSETS }, ctx) };`,
      },
      bundle: true, write: false, format: "esm", platform: "browser",
    });
    runtime = new Miniflare(convertV4MiniflareOptions({
      workers: [{ name: "pages", modules: true, compatibilityDate: "2026-09-01", script: bundle.outputFiles[0].text }],
    }));
  }, 20000);
  afterAll(async () => { await runtime?.dispose(); }, 20000);
  const get = (path: string) => runtime.dispatchFetch("http://localhost" + path);

  it("serves indexable pages with their own title, description, canonical and Open Graph tags", async () => {
    const response = await get("/pricing");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<title>Цени — Реч БГ</title>");
    expect(html).toContain(`content="${publicPages["/pricing"].description}"`);
    expect(html).toContain('<link rel="canonical" href="https://rechbg.com/pricing">');
    expect(html).toContain('<meta property="og:locale" content="bg_BG">');
    expect(html).not.toContain("noindex");
  }, 20000);
  it("keeps app, auth and detail pages out of the index but routable", async () => {
    for (const path of ["/login", "/app", "/app/studio/abc", "/app/video-studio/abc"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
      expect(html).not.toContain("canonical");
    }
    expect(await (await get("/app/studio/abc")).text()).toContain("<title>Аудио студио — Реч БГ</title>");
  }, 20000);
  it("returns 404 for unknown paths while still rendering the app's not-found page", async () => {
    const response = await get("/no-such-page");
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('<div id="root">');
    expect(html).toContain("noindex");
    expect((await get("/assets/app.js")).status).toBe(200);
  }, 20000);
  it("lists every public page in the sitemap and links it from robots.txt", async () => {
    const sitemap = await (await get("/sitemap.xml")).text();
    for (const path of Object.keys(publicPages)) expect(sitemap).toContain(`<loc>https://rechbg.com${path}</loc>`);
    expect(await (await get("/robots.txt")).text()).toContain("Sitemap: https://rechbg.com/sitemap.xml");
  }, 20000);
});
