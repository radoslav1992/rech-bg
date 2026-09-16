# Media Studio deployment

This release adds background MP4 exports, captions for uploaded videos, and avatar-with-product image variants. All user-facing controls are Bulgarian. Existing audio/video generation works while the new feature is disabled.

## Cloudflare setup

1. Apply `migrations/0003_media_studio.sql` to the existing D1 database **rech-bg**. With an authenticated Wrangler session:

   ```sh
   npx wrangler d1 execute rech-bg --remote --file migrations/0003_media_studio.sql
   ```

   This migration only creates tables/indexes/triggers, uses `IF NOT EXISTS`, and can be applied again. It does not alter or erase existing rows. Using `d1 execute --file` avoids replaying older migrations that were originally installed from the dashboard console. If copying into the D1 console instead, execute each complete statement separately, including each complete `CREATE TRIGGER ... END;` statement.

2. Enable **Cloudflare Containers** for the account (Workers Paid required). The existing GitHub Workers Build should run `npm run build`, then `npx wrangler deploy`. Use a full deploy, not `wrangler versions upload` or `--containers-rollout=none`, to publish the renderer image. The Dockerfile is `renderer/Dockerfile`; its build context is the `renderer` folder. The first image rollout can take several minutes. The deploying API token needs the Container Registry / Containers / Durable Objects permissions required by Cloudflare in addition to existing Worker permissions.

3. Retain existing server-side secrets **ELEVENLABS_API_KEY** and **FAL_KEY**. The ElevenLabs key must permit speech-to-text as well as text-to-speech, with account credits available. Product images use the existing fal account. No new Stripe products, Price IDs, or renderer API key are needed for these metered operations.

4. After the migration and successful container deployment, set the Worker runtime variable **MEDIA_ENABLED=true**, then deploy the settings. Keep **SITE_URL=https://rechbg.com**. The flag defaults to disabled if absent, so an incomplete setup cannot interrupt ordinary generation. The private container only accepts media-input URLs from that origin.

5. Test one short upload (with speech), one background caption export, and a two-variant product generation using an admin account. Confirm `rech-bg-media` finishes, files appear under **Медийни инструменти**, and MP4 downloads play with audio. Real provider requests spend account credit; automated tests mock paid providers.

Cloudflare creates the `MEDIA_GENERATION` Workflow binding and `MEDIA_RENDERER` Durable Object/container binding from wrangler.jsonc. The renderer pool is capped at three standard-2 instances, one FFmpeg job at a time each. Idle containers sleep after one minute. No public renderer endpoint exists.

## Charges and storage

| Operation | Credits |
| --- | ---: |
| 2 product image variants | 5,000 |
| 4 product image variants | 10,000 |
| Uploaded-video transcription, including first background export | 1,000 / started minute |
| First background export of a generated avatar video | Included |
| Additional background export | 500 / started minute |
| Redownload an existing output / SRT / VTT / local browser export | Free |

Existing speech and avatar video rates are unchanged. Product images use `fal-ai/nano-banana-pro/edit`, 1K JPEG, `num_images=2` or `4`, and private temporary input URLs. Only still-image composition is purchased at that step: subsequent avatar video is charged separately, using the existing 300 / 900 / 1800 credits per started second. No provider/model names are shown in the product controls.

| Plan | Media space | Completed recordings/exports |
| --- | ---: | ---: |
| Trial | 100 MiB | 7 days |
| Starter | 2 GiB | 30 days |
| Creator | 10 GiB | 90 days |
| Studio | 20 GiB | 180 days |

Limits: 300 files and 100 projects per account; upload video <=500 MiB, <=600 seconds, <=4096 pixels per dimension and <=9 million pixels total. FFprobe verifies duration and a real video/audio stream before a transcript can be ordered; credit quotes never trust browser duration. Export up to 1080p, 30fps. Inputs are uploaded in authenticated 8 MiB chunks with exact part sizes and server-held part receipts. Storage is reserved before accepting uploads or paid work, including generated speech/video.

Failed jobs refund their original credit window exactly once. Paid provider submissions use durable claim markers and are not automatically retried if submission is ambiguous. A Workflow dispatch error leaves the reservation for cron reconciliation. Snapshot settings belong to each export; later caption edits do not change queued or completed outputs. Billing receipts remain after request payloads are removed, preventing duplicate free exports.

Unfinished uploads expire after 24 hours. Unselected product variants expire after 7 days. Explicitly saved portraits/products/variants are extended through the paid subscription period plus a 30-day download grace period. Completed recordings keep their original retention date if the user changes plans. Active processing delays cleanup. Quota exhaustion blocks new reservations; it does not silently delete saved files.

Hourly cleanup removes expired R2 objects and abandoned multipart uploads. Add an R2 lifecycle rule to abort incomplete multipart uploads after one day as a second line of cleanup; **do not** add a blanket object-expiry rule to the shared bucket (voice samples/configuration must remain). The application protects active inputs; bucket-wide TTL rules would bypass that protection.

Pre-existing audio/video files are indexed in batches of 100 by cron, with a fresh retention period starting when indexed. They are counted even if the account is over quota; the historical files are not deleted to make space. Their index receipt prevents deleted/expired files from being reimported. Per-user media listings show size, state, and expiry. Project scripts and caption text attached to upload records remain until that media record is deleted; download SRT/VTT if it must outlive the video. Existing generated-speech timing JSON expires with its audio.

Provider payloads and temporary URL capabilities are removed from completed media task rows after 30 days. Console diagnostics contain only task ID, operation kind, and a constrained error code, not scripts, images, tokens or provider response bodies. Set **Workers Logs retention to 30 days or less** in Cloudflare; account log retention is not managed by this repository.

## Renderer behavior and validation

FFmpeg/libass runs in a private non-root Python container. It downloads only application-generated capability URLs, refuses redirects, caps download size and input dimensions, rejects remote playlist formats, processes local files only, and times out processing. Rendering preserves audio as AAC and produces H.264 MP4 with faststart. Local temporary files are removed after result retrieval and on container shutdown; completed stale entries are reclaimed on subsequent requests.

Eight caption styles, custom colors, text size, capitalization, three positions, contain/cover framing, four aspect ratios, and 720p/1080p are supported. The background renderer uses Noto Sans with Cyrillic support; browser preview/local export uses the app canvas font, so line wrapping and text shape can differ slightly. Review the downloaded MP4 before publishing.

Automated coverage includes migration triggers, storage/credit rollback, exactly-once refunds, input ownership, private capabilities, chunked upload validation, transcription and image request contracts, background completion, and expiry protection. A local FFmpeg check verifies burned Bulgarian captions, dimensions, and preserved audio. The full Docker image, live Cloudflare bindings, and paid providers need the deployment smoke test above.
