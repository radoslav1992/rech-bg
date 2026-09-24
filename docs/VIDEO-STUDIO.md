# Video Studio

The dedicated Bulgarian video workspace is `/app/video-studio`. Existing audio projects remain at `/app/studio`; video generation defaults to the existing WaveSpeed/fal stack and can be switched to HeyGen using a server variable.

## Choose the video provider

In Cloudflare → Workers & Pages → `rech-bg` → Settings → Variables and Secrets, set the text variable **`VIDEO_PROVIDER`**:

| Value | New video jobs | Required secrets |
| --- | --- | --- |
| `fal` (default when absent/blank; `fal.ai` also accepted) | Low: InfiniteTalk Fast through WaveSpeed; Medium: Kling Standard through fal; High: Kling Pro through fal | `WAVESPEED_API_KEY` for Low; `FAL_KEY` for Medium/High |
| `heygen` | Medium: Kling Avatar V2 Standard through fal. High: Avatar IV directly from the uploaded/library portrait. Low is unavailable. | `FAL_KEY` for Medium; `HEYGEN_API_KEY` for High |

Save and deploy the variables, then refresh the studio. Unknown values disable new video generation rather than silently choosing another paid provider. Each tier requires its own provider key: Medium requires `FAL_KEY` even in HeyGen mode; High requires `HEYGEN_API_KEY` in HeyGen mode. A missing key disables that tier without falling back to a different provider. Keys are server-only **secrets**, without a `VITE_` prefix, authorization prefix or surrounding quotes. No D1 migration or additional binding is required. `keep_vars: true` retains dashboard variables across GitHub deployments; no provider setting is forced in Wrangler.

Rates stay **900 credits per started second for Medium** and **1,800 for High** (27,000 / 54,000 for 30 seconds), plus the separately approved audio. New Medium jobs use Kling Standard directly, so they do not create a HeyGen photo avatar or incur its creation fee. Audio, voice samples, product-placement images and caption/export processing are unaffected by this video-only switch. Other features can still require their existing fal/ElevenLabs keys.

The provider is saved in `video_meta.provider` when each new job is accepted. Keep previous provider secrets while their jobs finish: switching the variable affects only new jobs. Older jobs without a snapshot keep historical tier-based routing; saved provider tickets determine status/result polling. There is no automatic cross-provider fallback or paid POST retry. The workflow runs in the background, saves MP4 to private R2, and retains existing credit refunds and optional email notifications.

In HeyGen mode, High uses `POST https://api.heygen.com/v3/videos` with `type: image`, `image: { type: url, url: ... }`, the approved `audio_url`, `resolution: 1080p`, `aspect_ratio: auto`, and an `Idempotency-Key` equal to the job ID. The raw-image schema uses Avatar IV by default and does not accept an `engine` field. Status/results use authenticated `GET /v3/videos/{video_id}`. Input URLs are temporary capabilities; the output is copied to R2 without forwarding the API key. HeyGen account activity titles use `Rech BG {jobId}` for reconciliation. API billing is separate from a regular HeyGen web subscription.

**Legacy jobs only:** Medium jobs already accepted with `video_meta.provider=heygen` retain their Avatar III workflow; new Medium jobs always save `provider=fal`. The legacy workflow first creates an isolated photo avatar using `POST /v3/avatars` (`type: photo`, `file: {type: url, url: ...}`) with idempotency key `avatar:{jobId}`. Its look/group IDs and submission claim are persisted in existing D1 metadata. Separate Workflow steps poll `/v3/avatars/looks/{lookId}` up to 60 times, sleeping 10 seconds between processing responses. The UI shows **Подготовка на аватара**. A completed photo look must explicitly support `avatar_iii`; otherwise generation fails and the video credit reservation is refunded. Then `/v3/videos` receives `type: avatar`, `avatar_id`, `engine: {type: avatar_iii}`, and the original `audio_url`. It sends no script, HeyGen voice, motion prompt or expressiveness option. A resumed video request skips photo creation entirely. This uses the current v3 Avatar III engine, not the older legacy v1/v2 engine.

New HeyGen High jobs need video create/read access. While any legacy Avatar III jobs or cleanup tasks remain, keep avatar create/read/delete access on the key as well. Only temporary groups created for these jobs are deleted after success/failure. Cleanup uses the existing `cleanup_tasks` table with `heygen-avatar/{jobId}/{groupId}` entries, separate from R2 cleanup. Failed cleanup is retried by scheduled maintenance and survives project/account deletion; it never reverses a completed video or its credits. Active jobs retain their avatar. Keep `HEYGEN_API_KEY` until pending video and cleanup tasks finish. An ambiguous avatar-creation response is not automatically retried; if no IDs were returned/saved, review `Rech BG {jobId}` in HeyGen to reconcile a potentially orphaned avatar. No new migration is needed.

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

1. Save an editable studio script of up to 1,500 characters. Select a curated voice and insert supported emotion tags manually, or request an AI suggestion. The AI returns only allowed emotion tags and word indices; the server inserts them into the original script without rewriting words, punctuation or whitespace. The button shows progress and errors locally; review the suggestion and click **Приложи** to apply it, or undo it. Up to five successful suggestions per verified user per UTC day are included. Provider errors, invalid suggestions and timeouts release the daily reservation. A separate limit of 20 attempts per UTC hour bounds failed calls. Existing exhausted failed-attempt allowances are reset by the new counter scope; no migration is needed. The server stops waiting after 35 seconds and the browser after 45 seconds, without automatic retries. The provider may still finish a request after the deadline. Switching projects discards pending suggestions.
2. Generate the speech preview using the official ElevenLabs JavaScript SDK, `eleven_v3`, Bulgarian, and PCM 24 kHz with timestamps. The app stores WAV plus word timings in private R2 storage.
3. Listen and explicitly approve that recording. Create the avatar video separately, with its existing duration-based price shown before submission. The audio must be 5–60 seconds; the actual generated duration is checked server-side.
4. Arrange the project in the **Монтаж** timeline as soon as the approved speech exists. The picture track shows the chosen portrait until the avatar video is ready, then switches to the generated video automatically. Tracks: picture, voice (with waveform), caption blocks and background music. Drag the voice/picture clip to add a music-only intro (up to 10 s), hold the last frame at the end (up to 10 s), drag caption blocks or edit their words, and drag the music clip to pick which part of the song plays. Music has volume, automatic lowering under speech and fade in/out. The preview plays voice, music and captions in sync. See "Timeline" below.
5. Return to the project after background video generation. Edit caption words/times and choose from twenty visual presets: Karaoke, Marker, Bold, Focus, Classic, Minimal, Neon, Reveal, Bounce (Скок), Outline (Контур), Banner (Лента), Retro (Ретро), Underline (Подчертаване), Bubble (Балон), Wave (Вълна), Sticker (Стикер), Fade (Плавно), Tiles (Плочки), Luxe (Лукс) and Impact (Удар). Customize accent/text colors, size, capitalization and top/middle/bottom placement. Choose 9:16, 4:5, 1:1 or 16:9 framing with contain or center-crop fit. SRT and VTT export are available after audio generation.
6. Export an MP4 with the timeline (video, voice, music, captions) using browser WebCodecs/Mediabunny. Choose 720p or 1080p output (1080p changes frame dimensions; it does not restore missing source detail). The existing audio track is preserved. The export checks for discarded tracks rather than silently creating a silent file. Unsupported browsers show an actionable message; the original MP4 and subtitle files remain downloadable. Keep the page open during MP4 export; use current Chrome/Edge on desktop. Video rendering by the avatar provider remains in Cloudflare Workflows and does not require the page to stay open.

| Action | Shared wallet charge |
| --- | --- |
| Existing audio workspace | 1 credit per billable text character |
| Premium studio speech | 3 credits per character, including spaces, punctuation and emotion tags |
| Video low / medium / high | 300 / 900 / 1,800 credits per started second, additional to speech |
| Caption editing/export | Included |
| Delivery suggestions | 5 requests/day included |

Example: a 500-character tagged script costs 1,500 credits for speech. A resulting 30-second medium video costs another 27,000 credits: 28,500 total. Regenerating speech creates a new paid version; editing captions does not regenerate audio or video. Dollar costs depend on the owner's ElevenLabs plan and video provider rates; app credits are not ElevenLabs credits. Monthly plans are now €12 / €29 / €59 with unchanged credit allowances; follow the Stripe price migration steps in DEPLOYMENT.md. Existing jobs keep their reserved credit amounts.

## Timeline

The timeline is a client-side editor (`src/TimelineEditor.tsx`); no new endpoint, migration or binding is needed. Caption words and look are still stored through the existing captions endpoint (autosaved), so SRT/VTT and the server background export keep working. Timeline arrangement (voice offset, end hold, voice/music volume, ducking, fades) is stored in browser localStorage per user and recording. Music files and the chosen portrait are stored only in the browser's IndexedDB; they are never uploaded, so they do not count towards media storage and do not sync between devices. Music up to 50 MB in any format the browser can decode.

Export mixes voice and music with an OfflineAudioContext using the same loudness envelope as the preview, draws each frame (video, held first/last frame, captions) on a canvas and encodes H.264/AAC (or VP9/Opus where H.264 is unavailable) into MP4. It is enabled once the avatar video is completed. The server background export does not include music or timeline offsets; the UI says so. Users are responsible for the rights to music they add.

## Reliability and storage

- `mode='studio'` identifies premium projects and audio jobs; the existing `kind` audio/video distinction is preserved.
- Quota reservation/refund remains transactional through the existing D1 triggers. The server checks the client's premium quote against the saved script before reserving credits.
- SDK and Workflow retries are disabled for the paid speech POST. `submitted_at` claims it before submission; a restart reuses a saved WAV instead of paying again. An ambiguous request without a saved recording fails/refunds the user's credits rather than silently resubmitting. A provider charge can still exist in that ambiguous situation and must be reviewed by the operator.
- Speech timestamps are the normal caption source. If absent, one bounded Forced Alignment call attempts to recover timings without regenerating speech. Alignment failure keeps the successful audio and allows manual caption entry.
- Captions live at `audio/{userId}/{audioJobId}.captions.json`, covered by existing project/account cleanup prefixes. Caption reads/writes require ownership; writes validate bounded, ordered, non-overlapping timings within the audio duration.
- The preview, preset thumbnails and MP4 export share the canvas caption renderer, including active-word timing and two-line wrapping. An animated sample is available before the video is ready.
- Up to eight named visual templates can be saved in browser localStorage, scoped to the signed-in user. Templates store only appearance settings, never caption text. They do not sync between devices; per-recording settings still sync through R2.
- Caption style/timing edits are saved to R2. Exported captioned MP4 files are downloaded to the user's device, not uploaded as another server-side video version.

## Verification after adding the key

Create a short Bulgarian studio script, generate and listen to speech, and confirm one TTS request in ElevenLabs. Approve it and generate a short video with the existing provider keys. Check caption timing and export a captioned MP4 with audible sound. No live ElevenLabs charge was made during implementation; automated checks use provider fixtures.
