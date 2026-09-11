import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { Env } from "./types";
import { now } from "./types";
import { segments, decodeAudio, wavHeader, voiceMap, TTS_MODEL } from "./audio";
export class AudioGeneration extends WorkflowEntrypoint<
  Env,
  { jobId: string }
> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const id = event.payload.jobId;
    try {
      const job = await step.do("load-project-snapshot", async () => {
        const job = await this.env.DB.prepare("SELECT * FROM jobs WHERE id=?")
          .bind(id)
          .first<any>();
        if (!job || !["queued", "running"].includes(job.status))
          throw new Error("Job unavailable");
        await this.env.DB.prepare(
          "UPDATE jobs SET status='running',updated_at=? WHERE id=?",
        )
          .bind(now(), id)
          .run();
        return job;
      });
      const turns = segments(job.script, job.mode, job.voice, job.second_voice);
      const parts: { key: string; size: number; rate: number }[] = [];
      for (let i = 0; i < turns.length; i++)
        parts.push(
          await step.do(
            "voice-segment-" + i,
            {
              retries: { limit: 1, delay: "5 seconds", backoff: "exponential" },
              timeout: "5 minutes",
            },
            async () => {
              const key = `segments/${job.user_id}/${id}/${i}.pcm`;
              const existing = await this.env.AUDIO.head(key);
              if (existing)
                return {
                  key,
                  size: existing.size,
                  rate: Number(existing.customMetadata?.rate),
                };
              const result = (await this.env.AI.run(TTS_MODEL, {
                text: turns[i].text,
                voice: voiceMap[turns[i].voice],
              })) as { audio?: string };
              if (!result?.audio) throw new Error("No audio returned");
              const { pcm, rate } = decodeAudio(result.audio);
              await this.env.AUDIO.put(key, pcm, {
                customMetadata: { rate: String(rate) },
              });
              await this.env.DB.prepare(
                "UPDATE jobs SET updated_at=? WHERE id=?",
              )
                .bind(now(), id)
                .run();
              return { key, size: pcm.length, rate };
            },
          ),
        );
      await step.do("assemble-and-complete", async () => {
        const rate = parts[0].rate;
        if (parts.some((p) => p.rate !== rate))
          throw new Error("Mismatched sample rates");
        const pauseBytes = Math.round((rate * job.pause_ms) / 1000) * 2;
        const total =
          parts.reduce((s, p) => s + p.size, 0) +
          pauseBytes * Math.max(0, parts.length - 1);
        if (total > 100_000_000) throw new Error("Audio exceeds limit");
        const key = `audio/${job.user_id}/${id}.wav`;
        // Fixed-length stream keeps long recordings below Worker memory limits and lets R2 know the length.
        const { readable, writable } = new FixedLengthStream(total + 44);
        const writer = writable.getWriter();
        const feed = (async () => {
          try {
            await writer.write(wavHeader(total, rate));
            for (let i = 0; i < parts.length; i++) {
              const obj = await this.env.AUDIO.get(parts[i].key);
              if (!obj) throw new Error("Missing segment");
              const reader = obj.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writer.write(value);
              }
              if (i < parts.length - 1 && pauseBytes)
                await writer.write(new Uint8Array(pauseBytes));
            }
            await writer.close();
          } catch (e) {
            await writer.abort(e);
            throw e;
          }
        })();
        await Promise.all([
          this.env.AUDIO.put(key, readable, {
            httpMetadata: { contentType: "audio/wav" },
          }),
          feed,
        ]);
        await this.env.DB.prepare(
          "UPDATE jobs SET status='completed',audio_key=?,duration=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
        )
          .bind(key, total / rate / 2, now(), id)
          .run();
      });
      await step.do("remove-temporary-segments", async () => {
        await this.env.AUDIO.delete(parts.map((p) => p.key));
      });
    } catch (error) {
      console.error("Audio workflow failed", {
        jobId: id,
        error: error instanceof Error ? error.name : "Unknown",
      });
      await step.do("refund-failed-recording", async () => {
        await this.env.DB.prepare(
          "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT 'segments/'||user_id||'/'||id||'/',? FROM jobs WHERE id=?",
        )
          .bind(now(), id)
          .run();
        await this.env.DB.prepare(
          "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
        )
          .bind(
            "Записът не беше създаден. Символите са върнати. Опитайте отново.",
            now(),
            id,
          )
          .run();
      });
      throw error;
    }
  }
}
