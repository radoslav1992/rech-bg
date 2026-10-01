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

Existing speech and avatar video rates are unchanged. Product images use `fal-ai/nano-banana-pro/edit`, 1K JPEG, `num_images=2` or `4`, and private temporary input URLs. Only still-image composition is purchased at that step: subsequent avatar video is charged separately, using the video rates (150 / 400 / 1200 credits per started second). No provider/model names are shown in the product controls.

| Plan | Media space | Completed recordings/exports |
| --- | ---: | ---: |
| Trial | 100 MiB | 7 days |
| Starter | 2 GiB | 30 days |
| Creator | 10 GiB | 90 days |
| Studio | 20 GiB | 180 days |

Limits: 300 files and 100 projects per account; upload video <=500 MiB, <=600 seconds, <=4096 pixels per dimension and <=9 million pixels total. Images (portraits, products, backgrounds, overlays) are checked from their PNG/JPEG header on upload and again with FFprobe in the renderer: at most 4096×4096 pixels, so a small file declaring huge dimensions cannot exhaust the renderer's memory. Downloads into the renderer also have an overall 10-minute deadline. FFprobe verifies duration and a real video/audio stream before a transcript can be ordered; credit quotes never trust browser duration. Export up to 1080p, 30fps. Inputs are uploaded in authenticated 8 MiB chunks with exact part sizes and server-held part receipts. Storage is reserved before accepting uploads or paid work, including generated speech/video.

Failed jobs refund their original credit window exactly once. Paid provider submissions use durable claim markers and are not automatically retried if submission is ambiguous. A Workflow dispatch error leaves the reservation for cron reconciliation. Snapshot settings belong to each export; later caption edits do not change queued or completed outputs. Billing receipts remain after request payloads are removed, preventing duplicate free exports.

Unfinished uploads expire after 24 hours. Unselected product variants expire after 7 days. Explicitly saved portraits/products/variants are extended through the paid subscription period plus a 30-day download grace period. Completed recordings keep their original retention date if the user changes plans. Active processing delays cleanup. Quota exhaustion blocks new reservations; it does not silently delete saved files.

Hourly cleanup removes expired R2 objects and abandoned multipart uploads. A media task that is still open two hours after it started (its workflow errored, finished without a result, or cannot be found) is failed and refunded, so it never blocks the user's next render or file deletion; a render still running for a failed task is stopped (`DELETE /jobs/{id}` on its renderer kills FFmpeg and frees the slot at once). Every run ends with one "Maintenance attention" log line when something is overdue (jobs or media tasks running over 3 hours, tools over 12 hours, avatars stuck creating, cleanup older than a day) — add a Cloudflare alert on that text. The 03:00 UTC run also re-reads from Stripe the customers whose plan looks doubtful (a paid period that ended without renewal, a payment problem, or a recent checkout without an active subscription), as a backstop for missed webhooks; it logs "Stripe reconciliation" with the counts. Add an R2 lifecycle rule to abort incomplete multipart uploads after one day as a second line of cleanup; **do not** add a blanket object-expiry rule to the shared bucket (voice samples/configuration must remain). The application protects active inputs; bucket-wide TTL rules would bypass that protection.

Pre-existing audio/video files are indexed in batches of 100 by cron, with a fresh retention period starting when indexed. They are counted even if the account is over quota; the historical files are not deleted to make space. Their index receipt prevents deleted/expired files from being reimported. Per-user media listings show size, state, and expiry. Project scripts and caption text attached to upload records remain until that media record is deleted; download SRT/VTT if it must outlive the video. Existing generated-speech timing JSON expires with its audio.

Provider payloads and temporary URL capabilities are removed from completed media task rows after 30 days. Console diagnostics contain only task ID, operation kind, and a constrained error code, not scripts, images, tokens or provider response bodies. Set **Workers Logs retention to 30 days or less** in Cloudflare; account log retention is not managed by this repository.

## Renderer behavior and validation

FFmpeg/libass runs in a private non-root Python container. It downloads only application-generated capability URLs, refuses redirects, caps download size and input dimensions, rejects remote playlist formats, processes local files only, and times out processing. Rendering preserves audio as AAC and produces H.264 MP4 with faststart. Local temporary files are removed after result retrieval and on container shutdown; completed stale entries are reclaimed on subsequent requests.

Twenty caption styles, custom colors, text size, capitalization, three positions, contain/cover framing, four aspect ratios, and 720p/1080p are supported. The background renderer uses Noto Sans with Cyrillic support; browser preview/local export uses the app canvas font, so line wrapping and text shape can differ slightly. The newer styles (Bounce, Outline, Banner, Retro, Underline, Bubble, Wave, Sticker, Fade, Tiles, Luxe, Impact) are approximated with libass: for example, Banner and Bubble use a text box instead of a full-width band or speech tail, Wave tilts the spoken word instead of bobbing, and Tiles uses one box per line. Luxe uses Noto Serif italic. Review the downloaded MP4 before publishing.

Automated coverage includes migration triggers, storage/credit rollback, exactly-once refunds, input ownership, private capabilities, chunked upload validation, transcription and image request contracts, background completion, and expiry protection. A local FFmpeg check verifies burned Bulgarian captions, dimensions, and preserved audio. The full Docker image, live Cloudflare bindings, and paid providers need the deployment smoke test above.

## Превод с дублаж (HeyGen Video Translation)

Медийни инструменти shows one card per tool (Субтитри, Превод с дублаж, Аватар с продукт, Кратки клипове, Преозвучаване); a card opens the tool in a dialog. `?tool=captions|dubbing|product` opens one directly (`?asset=` alone keeps opening Субтитри for that video, e.g. from the studio), and each ready video in "Вашите файлове" has a translate shortcut.

The video pickers in Превод с дублаж and Кратки клипове (`src/VideoSource.tsx`) also take a **new upload right in the tool**: after the consent checkbox, the file goes through the usual media upload (MP4, MOV or WebM up to 500 MB, kind `upload`, free) and the automatic check; once the video is ready it is selected automatically, or the tool says why it does not fit (e.g. shorter than 20 seconds for Кратки клипове, longer than 10 minutes for dubbing). The upload stays in "Вашите файлове".

**Превод с дублаж** translates a video from the library (an upload, a studio export or an avatar video made in the studio, up to 10 minutes) into another language, cloning the speakers' voices and, except in "Само глас", matching the lips to the new text. The result is a **new video in the library** (kind `upload`), so it can be downloaded, subtitled, used in the studio or translated again.

- **Modes and prices** (`shared/tools.ts`, per started second of the source): Бързо (HeyGen `mode: speed`) 150 credits, Прецизно (`mode: precision`) 300, Само глас (`translate_audio_only: true`) 100. HeyGen API: $0.0135 / $0.025 / $0.0095 per second. Video plans only (Създател, Студио), verified email, consent to process the video and its voices.
- **Languages** come from `GET /v3/video-translations/languages` (names such as "English" or "Spanish (Spain)"), cached for a day in R2 (`config/heygen-languages.json`); popular ones are listed first.
- **Flow:** `POST /api/tools/translate` reserves the credits and the result's storage (a `checking` asset of 1.5× the source, 100 MB–1 GB) in one batch (`ai_tasks`, migration `0008_ai_tasks.sql`, credit triggers like media tasks; at most two running per account) and starts the video Workflow with `{toolTaskId}`. The Workflow sends `POST /v3/video-translations` once (`video: {type: url}` pointing at `/api/tool-inputs/{id}?token=…`, valid while the task runs, `Idempotency-Key` = task ID), polls `GET /v3/video-translations/{id}` with the same outage tolerance as avatar videos, copies `video_url` to R2 and marks the asset ready. A failure (or maintenance finding it stuck for 8 hours) refunds the credits and removes the reserved asset. Neither the source nor the result can be deleted while the task runs.
- **Routes:** `GET /api/tools/config`, `GET /api/tools/languages`, `GET /api/tools/tasks`, `POST /api/tools/translate`.
- **Deploy:** apply `migrations/0008_ai_tasks.sql` (`npm run db:remote`); `HEYGEN_API_KEY` needs video-translation access. No new bindings.

## Преозвучаване (HeyGen Lipsync + ElevenLabs)

**Преозвучаване** puts new words into a filmed video (an upload, a studio export or an avatar video, 3 seconds to 3 minutes): the new text (up to 2 500 characters, prefilled from the video's transcript when it has one) is spoken by **the speaker's own voice** or a studio voice, and HeyGen Lipsync makes the lips follow it. The result is a new video in the library.

- **Price** (`shared/tools.ts`): Бързо (`mode: speed`) 150 or Прецизно (`mode: precision`) 350 credits per started second of the longer of video and estimated speech (~13 characters per second), plus 3 credits per character for the voice. A text whose estimated speech is far longer than the video (over 1.25× + 3 s) is refused.
- **Own voice:** with a second consent ("my voice, or explicit permission"), the renderer cuts the first two minutes of the video's sound (`operation: sample`, mono MP3), ElevenLabs makes an **instant voice clone** for this task, speaks the text with `eleven_v3`, and the clone is **deleted right away**. A failed delete is queued as `elevenlabs-voice/{id}` and retried by maintenance. Studio voices use the same speech call without a clone.
- **Flow** (`server/tools-workflow.ts`, kind `lipsync` in `ai_tasks`): voice sample (own voice only) → speech, paid once (`tools/{user}/{task}/speech.mp3`) → `POST /v3/lipsyncs` (video through `/api/tool-inputs/{id}`, speech through `/api/tool-inputs/{id}/speech`, both with the task's token; `enable_dynamic_duration` so the video follows the speech) → `GET /v3/lipsyncs/{id}` until done → saved as a new video with the reported duration. Any failure refunds everything.
- **Provider copies:** after a dubbing, a re-voicing or an avatar video is saved here (or fails), the copy at HeyGen is deleted (`DELETE /v3/video-translations|lipsyncs|videos/{id}`); a failed delete is queued as `heygen-file/{kind}/{id}` and retried by maintenance for two weeks. Working files (`tools/{user}/{task}/`) are removed by the cleanup run.
- **Routes:** `POST /api/tools/revoice`; `GET /api/tools/config` now also returns `revoice` (enabled, modes, voices).
- **Deploy:** no migration (`ai_tasks` already allows `lipsync`). `HEYGEN_API_KEY` needs lipsync access and video/translation/lipsync delete; `ELEVENLABS_API_KEY` needs voice creation and deletion (instant voice cloning is in ElevenLabs' Starter plan and above). The renderer container changes (voice sample).

## Кратки клипове

**Кратки клипове** (a tool card in Медийни инструменти) turns a long video with speech into vertical short clips:

1. Pick an uploaded video (20 s or longer). Without a transcript, the dialog offers **Разпознай речта** (the usual transcription, 1 000 credits per started minute).
2. **Намери силните моменти** (`POST /api/tools/shorts/suggest`) splits the transcript into sentences (`sentencesOf`: sentence ends, pauses over 1.2 s, 40 words at most) and asks `STUDIO_SCRIPT_MODEL` for 3–5 non-overlapping moments of 15–60 s as **sentence ranges**, with a title and a one-line reason. The server turns them into time ranges on sentence boundaries (a little air before and after) and drops anything out of range, overlapping or outside 8–90 s. The transcript is sent as data, never as instructions. Free: 20 successful searches a day (failures do not count), 30 attempts an hour. Each suggestion is previewed in place (`#t=start,end`).
3. **Създай вертикален клип** creates a one-scene studio project (`POST /api/tools/shorts/project`): a filmed scene cut to the chosen range, voice cleanup on, and a project look of 9:16, "cover" framing, 1080p, captions in the middle. The dialog shows the usual export quote and renders it on confirmation; the result appears in "Вашите файлове". **Отвори в студиото** opens the same project in the video studio to adjust the cut, captions, logo or music first.

Pricing is the usual studio export (500 credits per started minute; the first export covered by a paid transcription is included). The project's caption look now applies to filmed scenes in the render and the preview (before, the look saved with the clip's transcript won). No migration is needed.
