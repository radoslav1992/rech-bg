# Video Studio

The dedicated Bulgarian video workspace is `/app/video-studio`. Existing audio projects remain at `/app/studio`; video generation defaults to the existing WaveSpeed/fal stack and can be switched to HeyGen using a server variable.

## Choose the video provider

In Cloudflare → Workers & Pages → `rech-bg` → Settings → Variables and Secrets, set the text variable **`VIDEO_PROVIDER`**:

| Value | New video jobs | Required secrets |
| --- | --- | --- |
| `fal` (default when absent/blank; `fal.ai` also accepted) | Low: InfiniteTalk Fast through WaveSpeed; Medium: Kling Standard through fal; High: Kling Pro through fal | `WAVESPEED_API_KEY` for Low; `FAL_KEY` for Medium/High |
| `heygen` (recommended) | **Saved avatars.** Low: HeyGen Avatar III; Medium: HeyGen Avatar IV — both animate a saved avatar (a linked library avatar or the user's own, see *Моите аватари*). High: coming later (Avatar V digital twin from a filmed video); shown as "Скоро". | `HEYGEN_API_KEY` |

Save and deploy the variables, then refresh the studio. Unknown values disable new video generation rather than silently choosing another paid provider. A missing key disables that tier without falling back to a different provider. Keys are server-only **secrets**, without a `VITE_` prefix, authorization prefix or surrounding quotes. `keep_vars: true` retains dashboard variables across GitHub deployments; no provider setting is forced in Wrangler. `VIDEO_MEDIUM` is no longer needed with `VIDEO_PROVIDER=heygen` (it only still applies in `fal` mode, see below).

The provider is saved in `video_meta.provider` when each new job is accepted. Keep previous provider secrets while their jobs finish: switching the variable affects only new jobs. Older jobs without a snapshot keep historical tier-based routing; saved provider tickets determine status/result polling. There is no automatic cross-provider fallback or paid POST retry. The workflow runs in the background, saves MP4 to private R2, and retains existing credit refunds and optional email notifications.

### Saved avatars (VIDEO_PROVIDER=heygen)

HeyGen charges far less per second for a saved avatar than for animating a new photo every time, and Avatar III does not accept raw photos at all. So every video uses an avatar created once and then only referenced:

- **Library avatars** (free for users): an administrator links each one once — Settings → Библиотека с аватари → Редактирай → *HeyGen · готов за видео* — by pasting the ID of a photo avatar (look) in the HeyGen account, or with "Създай в HeyGen от портрета". HeyGen fetches the portrait through a 15-minute token link (`/api/avatar-inputs/{id}/image`); then press "Провери състоянието". The server keeps the engines HeyGen lists for the look (`supported_api_engines`). Linked avatars carry a "Готов за видео" badge in the picker.
- **Моите аватари** (the user's own): in the avatar picker a user uploads a photo (JPG/PNG up to 5 MB) or picks one from their media library, names it, confirms consent and pays **10 000 credits once** (`AVATAR_CREDITS`). The server stores the photo in R2 (`avatars/{user}/{id}/`), creates a HeyGen photo avatar (`POST /v3/avatars`, HeyGen reads the photo through `/api/user-avatar-inputs/{id}?token=…`, valid for an hour while it is created) and follows it on each list request until it is ready (usually 1–2 minutes). A refused photo (moderation), a HeyGen error, or 30 minutes without a result marks it failed and refunds the credits (D1 triggers, like media tasks). Up to 20 avatars per account; deleting one removes the photo and the HeyGen avatar (retried by maintenance) and is refused while a video with it is still being created. Deleting the account removes them too. Table: `user_avatars` (migration `0007_user_avatars.sql`). Routes: `GET/POST /api/my-avatars`, `GET /api/my-avatars/:id/image`, `DELETE /api/my-avatars/:id`. Creating an avatar needs the Създател or Студио plan, like video.
- **Videos:** `POST /api/videos` takes `libraryAvatarId` or `userAvatarId`; no photo is sent. The job saves `heygenAvatar` and `engine` (`avatar_iii` for Low, `avatar_iv` for Medium) in `video_meta`, and the workflow sends one `POST /v3/videos` with `type: avatar`, `avatar_id`, `engine: {type}` and the recording's `audio_url` — no per-video avatar creation, wait or cleanup. An avatar whose engine list lacks the tier's engine is refused before credits are reserved. A plain photo (own portrait, product image, unlinked library avatar) can still be chosen for the preview; the studio then asks for a saved avatar before video.
- **Engine name:** Avatar IV is sent as `engine: {type: "avatar_iv"}`, matching `avatar_iii`. The HeyGen docs could not be reached while this was built, so check the first Medium video; the engine check above makes a mismatch a clear error, not a failed paid job.

Jobs accepted before this change keep their route: High jobs from the previous HeyGen mode still use the raw-image Avatar IV schema (`type: image`, motion prompt), and older Medium jobs with `provider=heygen` still create a temporary photo avatar first (`heygen-avatar/{jobId}/{groupId}` cleanup tasks). Keep `HEYGEN_API_KEY` with avatar create/read/delete access.

### Recording length per video

One avatar video (one scene) takes a recording of 5 seconds up to **2 minutes** (`MAX_VIDEO_SECONDS` in `shared/video.ts`), except Medium on Kling Avatar V2 Standard (fal), which accepts at most **60 seconds**. `/api/videos/config` returns each tier's `maxSeconds`, `needsAvatar` and `soon`, and the studio shows them on the quality buttons. Longer videos join several scenes (up to 10 minutes). A scene script is up to 2 000 characters (about 2 minutes of speech). Finished videos up to 300 MB are stored (storage reserved per video: 100 MB, or 300 MB above 60 s).

### fal mode and VIDEO_MEDIUM

With `VIDEO_PROVIDER=fal`, Medium can still be switched to HeyGen Avatar III with linked library avatars by `VIDEO_MEDIUM=heygen` (Low and High stay on WaveSpeed/fal and animate the photo).

### Costs behind the prices

HeyGen API (self-serve, per second of video): Avatar III photo avatar $0.0165, Avatar IV photo avatar $0.0385, Avatar V (custom video avatar) $0.12; creating a photo avatar $1.32 once. At the Студио rate a credit is about €0.00024, so Low (150/sec) ≈ €0.035, Medium (400/sec) ≈ €0.095 and High (1 200/sec) ≈ €0.28 per second — roughly 2.5–3× the provider cost on Студио, more on Начало and Създател — and an avatar (10 000) ≈ €2.40. Cloudflare storage/processing and ElevenLabs speech are billed separately (speech is priced per character).

References: [Create video](https://developers.heygen.com/reference/create-video), [Get video](https://developers.heygen.com/reference/get-video), [Photo to avatar](https://developers.heygen.com/docs/avatar-from-photo), [Avatar III](https://developers.heygen.com/avatar-iii), [API billing](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained). Automated checks use mocked providers; after setup, verify a short video in each tier and its matching API account charge.

## Activate

In Cloudflare → Workers & Pages → `rech-bg` → Settings → Variables and Secrets, add the **secret** `ELEVENLABS_API_KEY` from your ElevenLabs account. Save and deploy the new Worker version. The key is used only by the server and its audio Workflow. It is never returned to the browser.

Enable Text to Speech access on the key and sufficient account credits. Forced Alignment access is useful as a fallback when speech generation returns no timings. Use a paid account suitable for your commercial use. Existing `AI`, `GENERATION`, `VIDEO_GENERATION`, `AUDIO`, D1 and video provider bindings remain in use. No new D1 migration, bucket or Workflow binding is needed.

Optional server configuration:

| Variable | Default / meaning |
| --- | --- |
| `ELEVENLABS_VOICES` | Optional fallback JSON mapping public voice IDs to provider voice IDs. Saved admin settings take precedence; omit to use the defaults below. |
| `STUDIO_SCRIPT_MODEL` | `openai/gpt-5.6-luna`, called through the existing Cloudflare AI binding using the Responses API shape. |

| Public ID | Bulgarian name | Default provider voice ID |
| --- | --- | --- |
| `studio-boris` | Борис | `JBFqnCBsd6RMkjVDRZzb` |
| `studio-mila` | Мила | `EXAVITQu4vr4xnSDxMaL` |
| `studio-nikola` | Никола | `onwK4e9ZLuTAKqWW03F9` |
| `studio-elena` | Елена | `XB0fDUnXU5powFXDhCwa` |

The provider/model identifiers are server-side; the product uses Bulgarian voice names. Preview a short Bulgarian script before choosing final voices for the brand. Emotion tags guide delivery; they do not guarantee a particular performance for every voice.

## Admin voice settings and samples

Go to **Настройки → Гласове за видео студиото** while signed in as an administrator (`ADMIN_EMAILS`). Click **Добави глас**, enter its Bulgarian name/description and ElevenLabs Voice ID, then click **Добави и запази гласа**. Each new voice is a separate persistent catalogue entry. To edit an existing voice, select it and click **Запази гласа**. Unsaved changes trigger a warning before switching voices or reloading. Only admins see provider IDs; the studio receives public IDs, labels and sample URLs. New settings apply without redeploying the Worker.

The initial four voices retain their saved admin configuration, with `ELEVENLABS_VOICES` and built-in values as fallbacks. Added voices use their saved settings. **Премахни гласа** removes an entry from the active catalogue, including a built-in voice; it never restores the default. Existing recordings remain available and already-queued speech jobs may finish with the archived mapping. New generation rejects removed or unknown voices before reserving credits. The existing secret `ELEVENLABS_API_KEY` stays in Cloudflare; it is never managed or exposed through this panel.

Click **Създай студиен пример** to synthesize the same `sampleSentence` used by standard TTS, with Eleven v3, Bulgarian and the selected saved voice. Listen to the draft and explicitly publish it. Generation consumes ElevenLabs usage but does not charge the administrator's application credit wallet. Paid sample requests have SDK retries disabled and share the existing 60-per-hour/admin sample generation limit. WAV/MP3 upload and sample removal are also available.

Video Studio uses a dropdown containing the active catalogue, with a playback button for the selected voice. It reloads the catalogue on window focus, and shows an explicit load error instead of falling back to the initial four. Published samples appear beside the dropdown. Changing the provider voice ID hides its old sample; publishing an outdated draft is rejected. Name/description-only changes keep the existing matching sample. Studio samples use revision-specific object keys so replacing them gets a fresh URL.

The catalogue is discovered from per-voice objects, including paginated listings, so concurrent additions do not overwrite a shared list. Removal archives the object with a tombstone, preventing default voices from reappearing. Configuration lives in private R2 at `config/studio-voices/{publicId}.json`; samples use the existing `voice_samples` D1 table and `samples/{publicId}/{voiceRevision}/{uuid}.wav` (or `.mp3`) R2 keys. No migration, new secret or binding is needed.

## Flow and credits

1. Save an editable studio script of up to 2,000 characters. Select a curated voice and insert supported emotion tags manually, or request an AI suggestion. The AI returns only allowed emotion tags and word indices; the server inserts them into the original script without rewriting words, punctuation or whitespace. The button shows progress and errors locally; review the suggestion and click **Приложи** to apply it, or undo it. Up to five successful suggestions per verified user per UTC day are included. Provider errors, invalid suggestions and timeouts release the daily reservation. A separate limit of 20 attempts per UTC hour bounds failed calls. Existing exhausted failed-attempt allowances are reset by the new counter scope; no migration is needed. The server stops waiting after 35 seconds and the browser after 45 seconds, without automatic retries. The provider may still finish a request after the deadline. Switching projects discards pending suggestions.
2. Generate the speech preview using the official ElevenLabs JavaScript SDK, `eleven_v3`, Bulgarian, and PCM 24 kHz with timestamps. The app stores WAV plus word timings in private R2 storage.
3. Listen and explicitly approve that recording. Create the avatar video separately, with its existing duration-based price shown before submission. The audio must be 5 seconds to 2 minutes (60 seconds on Kling Avatar V2 Standard); the actual generated duration is checked server-side.
4. Arrange the project in the **Монтаж** timeline as soon as the approved speech exists. The picture track shows the chosen portrait until the avatar video is ready, then switches to the generated video automatically. Tracks: picture, voice (with waveform), caption blocks and background music. Drag the voice/picture clip to add a music-only intro (up to 10 s), hold the last frame at the end (up to 10 s), drag caption blocks or edit their words, and drag the music clip to pick which part of the song plays. Music has volume, automatic lowering under speech and fade in/out. The preview plays voice, music and captions in sync. See "Timeline" below.
5. Return to the project after background video generation. Edit caption words/times and choose from twenty visual presets: Karaoke, Marker, Bold, Focus, Classic, Minimal, Neon, Reveal, Bounce (Скок), Outline (Контур), Banner (Лента), Retro (Ретро), Underline (Подчертаване), Bubble (Балон), Wave (Вълна), Sticker (Стикер), Fade (Плавно), Tiles (Плочки), Luxe (Лукс) and Impact (Удар). Customize accent/text colors, size, capitalization and top/middle/bottom placement. Choose 9:16, 4:5, 1:1 or 16:9 framing with contain or center-crop fit. SRT and VTT export are available after audio generation.
6. Export an MP4 with the timeline (video, voice, music, captions) using browser WebCodecs/Mediabunny. Choose 720p or 1080p output (1080p changes frame dimensions; it does not restore missing source detail). The existing audio track is preserved. The export checks for discarded tracks rather than silently creating a silent file. Unsupported browsers show an actionable message; the original MP4 and subtitle files remain downloadable. Keep the page open during MP4 export; use current Chrome/Edge on desktop. Video rendering by the avatar provider remains in Cloudflare Workflows and does not require the page to stay open.

| Action | Shared wallet charge |
| --- | --- |
| Existing audio workspace | 1 credit per billable text character |
| Premium studio speech | 3 credits per character, including spaces, punctuation and emotion tags |
| Video low / medium / high | 150 / 400 / 1,200 credits per started second, additional to speech (High when available) |
| Own video avatar from a photo | 10,000 credits once (refunded if creation fails) |
| Caption editing/export | Included |
| Delivery suggestions | 5 requests/day included |

Example: a 500-character tagged script costs 1,500 credits for speech. A resulting 30-second medium video costs another 12,000 credits: 13,500 total. Regenerating speech creates a new paid version; editing captions does not regenerate audio or video. Dollar costs depend on the owner's ElevenLabs plan and video provider rates; app credits are not ElevenLabs credits. Monthly plans are now €12 / €29 / €59 with unchanged credit allowances; follow the Stripe price migration steps in DEPLOYMENT.md. Existing jobs keep their reserved credit amounts.

## Scenes

A project is a list of scenes (up to 20). Each scene has its own title, script (up to 2,000 characters with emotion tags), voice, portrait/avatar, recordings and timeline (lead-in, end hold, voice volume); music belongs to the whole project. The scene strip above the editor adds, renames, reorders and removes scenes; the script editor, voice review, avatar panel and timeline below always work on the selected scene. Removing a scene keeps its recordings and videos (they stay in the account history).

Speech is generated per scene (`POST /api/generate` with `sceneId`): the server reads that scene's saved script and voice from the project document, so the price check and the recording always match what is saved. Only the scene you regenerate is charged; other scenes keep their recordings and videos. A scene whose script or voice changed after its last recording shows "Сценарият е променен". The first scene also stays mirrored in the project's own script/voice fields for older screens. Only one recording or video is generated at a time per account, as before.

**Цялото видео**: with more than one scene, the server export joins all scenes in order with cuts (each scene's lead-in, end hold, voice volume and caption style), normalized to the first scene's format, resolution and framing, with the project music under the whole video and ducking under every scene's speech. Every scene needs a finished avatar video first; the export names the scene that is not ready. The final video can be up to 10 minutes. It is priced as one video: the first render of the project is included, each further one 500 credits per started minute. The browser export in the timeline exports only the selected scene.

## Layers and backgrounds

Each scene can have up to 30 layers on its own clock, shown in the "Слоеве" track (one row per layer, drag to move, edit in "Избран клип"):

- **Text** — titles and lower thirds: up to 200 characters with line breaks, 9 positions inside a 5% safe margin, size, colour, optional box and bold.
- **Image** — a logo, sticker or product image (JPG/PNG from the media library or uploaded, up to 2 MB): position, width and opacity.
- **B-roll** — a full-frame cutaway while the voice continues: a still image or a video clip from the media library (uploaded clips are checked automatically first); the clip can start later (trim) and its own sound is not used.

The **scene background** (Формат → Фон на сцената) is a colour or an image that fills the space "contain" framing leaves around the avatar; with "cover" framing it is not visible. This is not background replacement behind the person — that needs matting and is not included.

Drawing order everywhere: background → avatar → B-roll → images → text → captions. The preview and the browser export draw layers on the canvas (`src/layers-render.ts`); the server render uses FFmpeg overlays and libass for text (`renderer/server.py`, `server/caption-ass.ts`), so fonts and line wrapping can differ slightly. A scene with **video** B-roll exports on the server only; text, images and still B-roll also export in the browser. Layer files are media assets and follow the plan's storage retention; a missing file is reported by the export with the scene number. No migration is needed; layers live in the project document.

## Plans

Avatar videos are available on the Създател and Студио plans. The trial (1 000 credits) and Начало (30 000) are audio only: their credits do not cover a video, so the server rejects video requests from them (`403`) and the studio shows a note with a link to the plans while the scenes and voice can still be prepared. The rule is `canCreateVideo` in `shared/catalog.ts`.

## One-screen editor

`/app/video-studio/:id` is a single editor (`src/studio/`) instead of step-by-step pages:

- **Scene rail** (left): add avatar scenes, filmed scenes (**Заснето видео**) and AI-written scenes (**Сцени с ИИ**); duplicate, reorder and delete them (up to 20). Each shows its presenter or clip, script start and state (draft, voice, video, filmed, cut, working, script changed).
- **Preview** (centre): plays the whole project in order — intro, every scene (its avatar video, or the portrait until the video is ready; voice, background, layers, captions) and outro — with the project music underneath, on the same clock as the timeline. Scenes without a voice yet appear with a length estimated from the script.
- **Inspector** (right): *Сцена* — title, avatar (**Избери аватар** opens a modal with every ready-made avatar, the user's portraits and product images, an upload and the product-avatar tool), voice, script with emotion tags and suggestions, **Създай глас** (priced per character), recording and video versions, **Създай видео** (tier, consent, price per second), voice volume, lead-in, end hold, background and new layers. *Избран клип* — the selected layer, caption block or music. *Проект* — format, resolution, framing, caption position and look (applied to every recording and to new ones), brand kit, intro/outro and templates.
- **Timeline** (bottom): one ruler for the final video with rows for scenes, voices, layers, captions and music; clips drag (or move with the arrow keys) and a click opens them in the inspector.
- **Експорт**: the server export of the whole project once every scene has a voice and video (with a checklist of what is missing), a free in-browser export for one-scene projects without intro/outro, and per-scene WAV, avatar video and SRT/VTT downloads.

Scenes generate independently, so several voices or videos can be in progress at once. There is no separate approval step: pressing **Създай видео** with the shown price is the approval. A scene points at its chosen recording and video; finished jobs are picked up automatically. `GET /api/jobs?project=<id>` lists all of a project's jobs (up to 400) so older versions stay selectable. Ready-made avatars are sent to the video provider as an image; own portraits and product avatars by reference.

## Filmed scenes, Мигновен монтаж and voice cleanup

A scene can be an uploaded video instead of an avatar (**Заснето видео** in the scene rail): the person records themselves, and the scene uses that picture and sound. Avatar scenes and filmed scenes mix freely in one project and share everything else — lead-in, end hold, volume, background, layers, captions, music, intro/outro and the export. The document stores `scene.clip = { assetId, keep, clean }` (`shared/project.ts`); the video is a media-library upload (MP4, MOV or WebM up to 500 MB and 10 minutes, checked automatically before use).

- **Разпознай речта** transcribes the clip with the existing media transcription (`POST /api/media/transcribe`, 1 000 credits per started minute, the same price as in Медия). The transcript gives the scene its captions and tells the editor where speech is. Words are corrected in Медия → Субтитри; in the studio a filmed scene's captions follow the cuts and only their look and on/off change.
- **Мигновен монтаж** (`shared/cuts.ts`) keeps the speech and removes silences longer than the chosen pause (0.2–1.5 s, default 0.6 s) and, optionally, hesitation sounds („ъъ“, „ммм“, „хм“, "uhm"). Single-letter words such as „а“ and „е“ are never treated as fillers. The result is a list of kept ranges (`keep`, up to 300); **Върни целия клип** clears it. The preview plays the cut immediately by seeking the source video; the server render cuts picture and sound with FFmpeg `select`/`aselect` from the same ranges, and captions move onto the cut clock (a word a cut runs through is dropped).
- **Изчисти звука** (on by default) adds high-pass/low-pass filtering, FFT noise reduction and loudness normalisation (−16 LUFS) to the clip's sound in the export. The preview plays the original sound.

A project with a filmed clip that was never transcribed is priced like any uploaded video export (500 credits per started minute); when every filmed clip was transcribed, the first render is included as for avatar projects. Filmed scenes export on the server only (the free browser export stays for one avatar scene).

## AI script writer

**Сценарий с ИИ** writes the scenes from a topic: on the new-project page (it creates the project with the written scenes) and in the editor (**Сцени с ИИ**, which adds them after the selected scene, replacing an untouched first scene). The user chooses a style (advertisement, story, calm narration, explainer) and a length (30 s, 1, 1.5 or 3 minutes); the server (`server/studio-writer.ts`, `POST /api/video-studio/write`) asks the `STUDIO_SCRIPT_MODEL` model for about 13 characters per second split into scenes of up to ~35 s, strips markup, and checks every scene against the studio script rules. The topic is sent as data, never as instructions, and the model is told not to invent prices or contact details. It is free for verified users, up to 10 successful scripts a day (failed attempts do not count) and 30 attempts an hour. The written scenes are shown for review before they are used, and stay editable.

## Brand kit, intro/outro and templates

Open **Проект → Бранд, интро, финал и шаблони** in the video studio.

- **Brand kit** (one per account): name, three colours (new text layers use the text and box colours), a logo (JPG/PNG with position, width, opacity — "Лого на бранда" among a scene's layer buttons adds it), a caption look taken from the selected scene, and an intro and outro.
- **Intro/outro**: an image held for 1–15 seconds, or a video clip cut to that length (it keeps its own sound; otherwise silence). The server export adds them before the first and after the last scene; the music plays across them; captions, layers and ducking after the intro are shifted accordingly. The preview and the browser export show only the scenes. They count toward the 10-minute limit and the export price.
- **Приложи бранда** sets the project's intro, outro and caption look, and rewrites the look of existing recordings' captions (words and timing stay). New recordings in the project start with that look. "Добави логото към всички сцени" adds the logo layer to every scene.
- **Templates**: "Запази като шаблон" stores the project's scenes, scripts, voices, layers, backgrounds, timing, music, intro/outro and caption look — never its paid recordings or videos (up to 50 per account). A new video project offers "Започнете от шаблон", which creates the project with fresh scenes; each scene's voice and video are then generated as usual. Files a template refers to follow the media retention rules; an expired file is reported at export.

Migration `0006_brand_templates.sql` adds the `brand_kits` and `studio_templates` tables. The renderer image changes (intro/outro segments), so deploy with a full `wrangler deploy`.

## Timeline

The timeline is edited in the browser (`src/studio/`) and saved on the server as part of the project document (`project_documents`, migration `0005`; format in `shared/project.ts`). The document is small JSON: scenes (the voice recording and video job IDs, a portrait reference, voice offset, end hold and voice volume) and the project music (a media asset ID plus start, volume, ducking and fades). It only references media; nothing heavy is stored in it. Edits save automatically after a short pause. A revision number protects against two tabs or devices overwriting each other: the later save gets the newer version and a notice instead of silently replacing it.

Caption words and look are still stored per recording through the captions endpoint (autosaved), so SRT/VTT and exports keep working. Music (MP3, WAV, M4A or OGG up to 50 MB) and an own portrait are uploaded once through the chunked media upload and count toward media storage and its retention period; library avatars and product images are saved as references without a copy. A music file that expires is reported in the timeline with an option to remove it. On first open, settings, music and portraits that earlier versions kept only in this browser (localStorage/IndexedDB) are imported into the project once and removed locally. Users are responsible for the rights to music they add.

Export in the browser mixes voice and music with an OfflineAudioContext using the same loudness envelope as the preview (`shared/timeline.ts`), draws each frame (video, held first/last frame, captions) on a canvas and encodes H.264/AAC (or VP9/Opus where H.264 is unavailable) into MP4. It is offered for one-scene projects without intro/outro once the avatar video is completed, and is free.

**Server export** (under **Експорт**, needs `MEDIA_ENABLED`) renders the same arrangement in the FFmpeg container: lead-in and end hold (first/last frame held), voice volume, music placement with the same fades and ducking, and captions shifted by the lead-in. It reads the saved document and captions on the server and snapshots them into the export task, so later edits do not change a queued render. The voice uses the video's own soundtrack when it matches the approved recording, otherwise the recording. Pricing follows the other exports: the first export of a generated video is included, each further one costs 500 credits per started minute of the timeline. The renderer's new `timeline` operation requires deploying the updated container image (a full `wrangler deploy`); an older renderer rejects it and the task is refunded.

## Reliability and storage

- `mode='studio'` identifies premium projects and audio jobs; the existing `kind` audio/video distinction is preserved.
- Video status is polled every 20 s for about an hour, then every 5 minutes for up to about 5 more hours, because a slow provider queue still finishes and is still billed. After that the job is refunded; a HeyGen/WaveSpeed ticket that may still complete is logged as `Video provider still running after timeout; review for manual pickup` with its request ID.
- A HeyGen submission interrupted after it was claimed but before its ticket was saved is re-sent with the same `Idempotency-Key` (the job ID) within 20 hours, recovering the original video instead of refunding it. Other providers still fail and refund such an ambiguous submission.
- Hourly maintenance fails and refunds any audio/video job still active 8 hours after creation (terminating its workflow), or whose workflow ended without recording a result, so a stuck job cannot hold credits or block the user.
- Provider input links stay valid while the job is active and for 6 hours after submission (or creation, before submission). Output downloads follow at most two redirects, each to an allowed host.
- Quota reservation/refund remains transactional through the existing D1 triggers. The server checks the client's premium quote against the saved script before reserving credits.
- SDK and Workflow retries are disabled for the paid speech POST. `submitted_at` claims it before submission; a restart reuses a saved WAV instead of paying again. An ambiguous request without a saved recording fails/refunds the user's credits rather than silently resubmitting. A provider charge can still exist in that ambiguous situation and must be reviewed by the operator.
- Speech timestamps are the normal caption source. If absent, one bounded Forced Alignment call attempts to recover timings without regenerating speech. Alignment failure keeps the successful audio and allows manual caption entry.
- Captions live at `audio/{userId}/{audioJobId}.captions.json`, covered by existing project/account cleanup prefixes. Caption reads/writes require ownership; writes validate bounded, ordered, non-overlapping timings within the audio duration.
- The preview, preset thumbnails and MP4 export share the canvas caption renderer, including active-word timing and two-line wrapping. An animated sample is available before the video is ready.
- Up to eight named visual templates can be saved in browser localStorage, scoped to the signed-in user. Templates store only appearance settings, never caption text. They do not sync between devices; per-recording settings still sync through R2.
- Caption style/timing edits are saved to R2. Exported captioned MP4 files are downloaded to the user's device, not uploaded as another server-side video version.

## Verification after adding the key

Create a short Bulgarian studio script, generate and listen to speech, and confirm one TTS request in ElevenLabs. Choose an avatar and generate a short video with the existing provider keys. Check caption timing and export a captioned MP4 with audible sound. No live ElevenLabs charge was made during implementation; automated checks use provider fixtures.
