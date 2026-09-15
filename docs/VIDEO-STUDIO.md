# Video Studio

The dedicated Bulgarian video workspace is `/app/video-studio`. Existing audio projects remain at `/app/studio`; video generation keeps the currently configured WaveSpeed/fal providers and quality tiers.

## Activate

In Cloudflare → Workers & Pages → `rech-bg` → Settings → Variables and Secrets, add the **secret** `ELEVENLABS_API_KEY` from your ElevenLabs account. Save and deploy the new Worker version. The key is used only by the server and its audio Workflow. It is never returned to the browser.

Enable Text to Speech access on the key and sufficient account credits. Forced Alignment access is useful as a fallback when speech generation returns no timings. Use a paid account suitable for your commercial use. Existing `AI`, `GENERATION`, `VIDEO_GENERATION`, `AUDIO`, D1 and video provider bindings remain in use. No new D1 migration, bucket or Workflow binding is needed.

Optional server configuration:

| Variable | Default / meaning |
| --- | --- |
| `ELEVENLABS_VOICES` | JSON mapping public voice IDs to voice IDs available in your account. Omit to use the defaults below. |
| `STUDIO_SCRIPT_MODEL` | `openai/gpt-5.6-luna`, called through the existing Cloudflare AI binding using the Responses API shape. |

| Public ID | Bulgarian name | Default provider voice ID |
| --- | --- | --- |
| `studio-boris` | Борис | `JBFqnCBsd6RMkjVDRZzb` |
| `studio-mila` | Мила | `EXAVITQu4vr4xnSDxMaL` |
| `studio-nikola` | Никола | `onwK4e9ZLuTAKqWW03F9` |
| `studio-elena` | Елена | `XB0fDUnXU5powFXDhCwa` |

The provider/model identifiers are server-side; the product uses Bulgarian voice names. Preview a short Bulgarian script before choosing final voices for the brand. Emotion tags guide delivery; they do not guarantee a particular performance for every voice.

## Flow and credits

1. Save an editable studio script of up to 1,500 characters. Select a curated voice and insert supported emotion tags manually, or request an AI suggestion. The server rejects suggestions that change any original characters after tags are removed. Up to five assistance requests per verified user per rolling day are included; failed requests count toward this abuse limit.
2. Generate the speech preview using the official ElevenLabs JavaScript SDK, `eleven_v3`, Bulgarian, and PCM 24 kHz with timestamps. The app stores WAV plus word timings in private R2 storage.
3. Listen and explicitly approve that recording. Create the avatar video separately, with its existing duration-based price shown before submission. The audio must be 5–60 seconds; the actual generated duration is checked server-side.
4. Return to the project after background video generation. Edit caption words/times and select Classic, Bold or word-highlight captions, bottom/middle placement, and 9:16, 1:1 or 16:9 framing. SRT and VTT export are available after audio generation.
5. Export an MP4 with captions burned into its frames using browser WebCodecs/Mediabunny. The existing audio track is preserved. The export checks for discarded tracks rather than silently creating a silent file. Unsupported browsers show an actionable message; the original MP4 and subtitle files remain downloadable. Keep the page open during MP4 export; use current Chrome/Edge on desktop. Video rendering by the avatar provider remains in Cloudflare Workflows and does not require the page to stay open.

| Action | Shared wallet charge |
| --- | --- |
| Existing audio workspace | 1 credit per billable text character |
| Premium studio speech | 3 credits per character, including spaces, punctuation and emotion tags |
| Video low / medium / high | 200 / 600 / 1,200 credits per started second, additional to speech |
| Caption editing/export | Included |
| Delivery suggestions | 5 requests/day included |

Example: a 500-character tagged script costs 1,500 credits for speech. A resulting 30-second medium video costs another 18,000 credits: 19,500 total. Regenerating speech creates a new paid version; editing captions does not regenerate audio or video. Dollar costs depend on the owner's ElevenLabs plan and video provider rates; app credits are not ElevenLabs credits. The existing Stripe prices do not need changes for this release.

## Reliability and storage

- `mode='studio'` identifies premium projects and audio jobs; the existing `kind` audio/video distinction is preserved.
- Quota reservation/refund remains transactional through the existing D1 triggers. The server checks the client's premium quote against the saved script before reserving credits.
- SDK and Workflow retries are disabled for the paid speech POST. `submitted_at` claims it before submission; a restart reuses a saved WAV instead of paying again. An ambiguous request without a saved recording fails/refunds the user's credits rather than silently resubmitting. A provider charge can still exist in that ambiguous situation and must be reviewed by the operator.
- Speech timestamps are the normal caption source. If absent, one bounded Forced Alignment call attempts to recover timings without regenerating speech. Alignment failure keeps the successful audio and allows manual caption entry.
- Captions live at `audio/{userId}/{audioJobId}.captions.json`, covered by existing project/account cleanup prefixes. Caption reads/writes require ownership; writes validate bounded, ordered, non-overlapping timings within the audio duration.
- Caption style/timing edits are saved to R2. Exported captioned MP4 files are downloaded to the user's device, not uploaded as another server-side video version.

## Verification after adding the key

Create a short Bulgarian studio script, generate and listen to speech, and confirm one TTS request in ElevenLabs. Approve it and generate a short video with the existing provider keys. Check caption timing and export a captioned MP4 with audible sound. No live ElevenLabs charge was made during implementation; automated checks use provider fixtures.
