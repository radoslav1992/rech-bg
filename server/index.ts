import { avatars } from "./avatars";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Env, ContextVars, DbUser } from "./types";
import { now } from "./types";
import { sha } from "./security";
import { pages } from "./pages";
import { auth } from "./auth";
import { billing, webhook } from "./billing";
import { billingFailure } from "./billing-errors";
import { withDefaults } from "./config";
import { studio } from "./studio";
import { videos, videoInputs } from "./video";
import { media, mediaInputs } from "./media";
import { publicRoutes } from "./routes/public";
import { projects } from "./routes/projects";
import { jobs } from "./routes/jobs";
import { settings } from "./routes/settings";
import { admin } from "./routes/admin";
import { maintenance } from "./maintenance";
export { maintenance };
export { MediaGeneration } from './media-workflow';
export { MediaRenderer } from './media-container';
export { AudioGeneration } from "./workflow";
export { VideoGeneration } from "./video-workflow";
const app = new Hono<{ Bindings: Env; Variables: ContextVars }>();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  if (new URL(c.req.url).protocol === "https:")
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  if (c.req.path.startsWith("/api/") && !c.req.path.startsWith("/api/voices/"))
    c.header("Cache-Control", "no-store");
});
app.use(
  "/api/media/uploads/:id/parts/:part",
  bodyLimit({ maxSize: 8 * 1024 * 1024, onError: c => c.json({error: "Фрагментът е твърде голям."}, 413) }),
);
app.use(
  "/api/*",
  async (c, next) => { if (/^\/api\/media\/uploads\/[^/]+\/parts\/\d+$/.test(c.req.path)) return next(); return bodyLimit({
    maxSize: 3 * 1024 * 1024,
    onError: (c) =>
      c.json({ error: "Файлът или заявката е твърде голяма." }, 413),
  })(c, next); },
);
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.path !== "/api/billing/webhook") {
    const supplied = c.req.header("Origin");
    const allowed = new URL(c.env.SITE_URL || c.req.url).origin;
    if (supplied !== allowed)
      throw new HTTPException(403, {
        message: "Невалиден произход на заявката.",
      });
  }
  await next();
});
app.post("/api/billing/webhook", async (c) =>
  c.json(await webhook(c.req.raw, c.env)),
);
app.route("/", publicRoutes);
app.route("/api/video-inputs", videoInputs);
app.route("/api/media-inputs", mediaInputs);
app.use("/api/*", async (c, next) => {
  const t = getCookie(c, "rech_session");
  if (t) {
    const hash = await sha(t);
    const u = await c.env.DB.prepare(
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?",
    )
      .bind(hash, now())
      .first<DbUser>();
    if (u) {
      c.set("user", u);
      c.set("session", hash);
    }
  }
  await next();
});
app.route("/api/auth", auth);
app.use("/api/*", async (c, next) => {
  if (!c.get("user"))
    throw new HTTPException(401, { message: "Влезте в профила си." });
  await next();
});
app.route("/api/billing", billing);
app.route("/api/videos", videos);
app.route("/api/video-studio", studio);
app.route("/api/media", media);
app.route("/api/avatars", avatars);
app.route("/", projects);
app.route("/", jobs);
app.route("/", settings);
app.route("/", admin);
app.all("/api/*", (c) => c.json({ error: "Страницата не е намерена." }, 404));
app.route("/", pages);
app.onError((e, c) => {
  if (e instanceof HTTPException) return c.json({ error: e.message }, e.status);
  // Malformed JSON bodies are client errors, not outages.
  if (e instanceof SyntaxError && c.req.method !== "GET" && c.req.path.startsWith("/api/"))
    return c.json({ error: "Невалидна заявка." }, 400);
  if (e instanceof z.ZodError)
    return c.json(
      {
        error:
          "Проверете въведените данни. " +
          e.issues.map((x) => x.path.join(".")).join(", "),
      },
      400,
    );
  if (c.req.path.startsWith("/api/billing/"))
    return c.json(billingFailure(e), 503);
  console.error("Request failed", { path: c.req.path, error: e.name });
  return c.json(
    { error: "Услугата временно не е достъпна. Опитайте отново след малко." },
    503,
  );
});
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, withDefaults(env), ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(maintenance(withDefaults(env))),
};
