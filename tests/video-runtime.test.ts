import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Exercise the real workerd Request/fetch implementation. Provider traffic is
// routed to a local Worker, so these tests use no credentials or paid requests.
describe("Video HTTP in the Cloudflare runtime", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `import { videoFetch } from './server/video-http';
          export default { async fetch(request) {
            try {
              const response = await videoFetch('https://queue.fal.run' + new URL(request.url).pathname, {
                method: 'POST', headers: { Authorization: 'Key local-fixture' },
                body: '{}', signal: AbortSignal.timeout(1000)
              });
              return Response.json({ status: response.status, body: await response.json() });
            } catch(error) { return Response.json({ error: error.message }, { status: 502 }); }
          } };`,
      },
      bundle: true, write: false, format: "esm", platform: "browser",
    });
    runtime = new Miniflare(convertV4MiniflareOptions({ workers: [
      { name: "video-client", modules: true, compatibilityDate: "2026-09-01", script: bundle.outputFiles[0].text, outboundService: "provider" },
      { name: "provider", modules: true, compatibilityDate: "2026-09-01", script: `export default { async fetch(request) {
        if (new URL(request.url).pathname === '/redirect') return Response.redirect('https://untrusted.invalid/target', 302);
        return Response.json({ request_id: 'local-request', method: request.method, authorized: request.headers.get('Authorization') === 'Key local-fixture' });
      } };` },
    ] }));
  }, 20000);
  afterAll(async () => { await runtime?.dispose(); }, 20000);
  it("sends a paid-style POST using a redirect mode supported by workerd", async () => {
    const response = await runtime.dispatchFetch("http://localhost/submit");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 200, body: { request_id: "local-request", method: "POST", authorized: true } });
  }, 20000);
  it("rejects redirects without forwarding the POST or credentials", async () => {
    const response = await runtime.dispatchFetch("http://localhost/redirect");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Video service redirect rejected" });
  }, 20000);
});
