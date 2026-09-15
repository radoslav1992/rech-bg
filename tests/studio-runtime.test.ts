import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
let runtime: Miniflare;
beforeAll(async () => {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
    export default { async fetch() {
      const client = new ElevenLabsClient({ apiKey: 'fixture-key' });
      const data = await client.textToSpeech.convertWithTimestamps('fixture-voice', {
        text: '[excited]Здравей!', modelId: 'eleven_v3', languageCode: 'bg', outputFormat: 'pcm_24000'
      }, { maxRetries: 0, timeoutInSeconds: 10 });
      return Response.json(data);
    } };` }, bundle: true, write: false, format: "esm", platform: "browser", external: ["node:*"], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/worker.js');" } });
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: "studio", modules: true, compatibilityFlags: ["nodejs_compat"], compatibilityDate: "2026-09-01", script: bundle.outputFiles[0].text, outboundService: "provider" },
    { name: "provider", modules: true, compatibilityDate: "2026-09-01", script: `export default { async fetch(request) {
      const body = await request.json(), url = new URL(request.url);
      if (request.headers.get('xi-api-key') !== 'fixture-key' || request.method !== 'POST' ||
          url.pathname !== '/v1/text-to-speech/fixture-voice/with-timestamps' || url.searchParams.get('output_format') !== 'pcm_24000' ||
          body.model_id !== 'eleven_v3' || body.language_code !== 'bg') return new Response('Bad provider request', { status: 400 });
      return Response.json({ audio_base64: 'AAA=', alignment: { characters: ['З'], character_start_times_seconds: [0], character_end_times_seconds: [0.1] } });
    } };` },
  ] }));
}, 20000);
afterAll(async () => { await runtime?.dispose(); });
it("runs the official speech SDK on real workerd with the expected authenticated request", async () => {
  const response = await runtime.dispatchFetch("http://localhost/");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ audioBase64: "AAA=", alignment: { characters: ["З"] } });
}, 20000);
