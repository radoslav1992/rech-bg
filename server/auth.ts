import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { Env, ContextVars, DbUser } from "./types";
import { now, uid, ready } from "./types";
import {
  checkPassword,
  hashPassword,
  token,
  sha,
  rate,
  sendMail,
  origin,
} from "./security";
import { allowance } from "./billing";
export const auth = new Hono<{ Bindings: Env; Variables: ContextVars }>();
const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((s) => s.toLowerCase().trim()),
  password: z.string().min(10, "Паролата трябва да е поне 10 знака.").max(128),
});
async function issue(
  env: Env,
  user: DbUser,
  kind: "verify" | "reset",
  base: string,
) {
  const t = token();
  await env.DB.prepare(
    "INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at) VALUES (?,?,?,?)",
  )
    .bind(
      await sha(t),
      user.id,
      kind,
      now() + (kind === "verify" ? 86400 : 3600),
    )
    .run();
  await sendMail(
    env,
    user.email,
    kind === "verify"
      ? "Потвърдете имейла си — Реч БГ"
      : "Нова парола — Реч БГ",
    `Здравейте, ${user.name}!\n\n${kind === "verify" ? "Потвърдете имейла си" : "Задайте нова парола"} от този линк:\n${base}/${kind === "verify" ? "verify" : "reset"}?token=${t}\n\nАко не сте заявили това, игнорирайте писмото.\nРеч БГ`,
  );
}
auth.get("/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  const limits = await allowance(c.env, user);
  return c.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      verified: !!user.verified,
      admin: isAdmin(c.env, user),
      ...limits,
      window: undefined,
    },
  });
});
auth.post("/register", async (c) => {
  if (c.env.REGISTRATION_ENABLED !== "true" || !ready(c.env))
    throw new HTTPException(503, {
      message: "Регистрациите ще бъдат отворени скоро.",
    });
  await rate(c, "register", 5);
  const body = await c.req.json();
  const d = credentials
    .extend({
      name: z.string().trim().min(2).max(80),
      acceptTerms: z.literal(true),
    })
    .parse(body);
  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM)
    throw new HTTPException(503, {
      message: "Регистрациите временно не са достъпни.",
    });
  if (c.env.APP_ENV !== "development" && !c.env.TURNSTILE_SECRET_KEY)
    throw new HTTPException(503, {
      message: "Регистрациите временно не са достъпни.",
    });
  if (c.env.TURNSTILE_SECRET_KEY) {
    const r = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({
          secret: c.env.TURNSTILE_SECRET_KEY,
          response: body.turnstileToken || "",
          remoteip: c.req.header("CF-Connecting-IP") || "",
        }),
      },
    );
    const result = (await r.json()) as { success: boolean; hostname?: string };
    if (
      !result.success ||
      (c.env.SITE_URL && result.hostname !== new URL(c.env.SITE_URL).hostname)
    )
      throw new HTTPException(400, {
        message: "Потвърдете проверката за сигурност.",
      });
  }
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email=?")
    .bind(d.email)
    .first();
  if (existing)
    throw new HTTPException(400, {
      message:
        "Регистрацията не може да бъде завършена. Опитайте вход или възстановяване на парола.",
    });
  const user = {
    id: uid(),
    email: d.email,
    name: d.name,
    password_hash: await hashPassword(d.password),
    verified: 0,
    created_at: now(),
    stripe_customer: null,
  };
  await c.env.DB.prepare(
    "INSERT INTO users(id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)",
  )
    .bind(user.id, user.email, user.name, user.password_hash, user.created_at)
    .run();
  let emailSent = true;
  try {
    await issue(c.env, user, "verify", origin(c.env, c.req.raw));
  } catch {
    emailSent = false;
  }
  await createSession(c, user.id);
  return c.json({ ok: true, emailSent });
});
async function createSession(c: any, userId: string) {
  const t = token();
  await c.env.DB.prepare(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
  )
    .bind(await sha(t), userId, now() + 2592000)
    .run();
  setCookie(c, "rech_session", t, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: 2592000,
  });
}
auth.post("/login", async (c) => {
  await rate(c, "login", 20);
  const { email, password } = credentials.parse(await c.req.json());
  await rate(c, "login-email", 15, 3600, email);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email=?")
    .bind(email)
    .first<DbUser>();
  const valid = await checkPassword(
    password,
    user?.password_hash ||
      "pbkdf2:100000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000",
  );
  if (!user || !valid)
    throw new HTTPException(401, { message: "Невалиден имейл или парола." });
  await createSession(c, user.id);
  return c.json({ ok: true });
});
auth.post("/logout", async (c) => {
  const t = getCookie(c, "rech_session");
  if (t)
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await sha(t))
      .run();
  deleteCookie(c, "rech_session", { path: "/" });
  return c.json({ ok: true });
});
auth.post("/forgot", async (c) => {
  await rate(c, "forgot", 5);
  const { email } = z
    .object({ email: z.email().transform((s) => s.toLowerCase().trim()) })
    .parse(await c.req.json());
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE email=?")
    .bind(email)
    .first<DbUser>();
  if (u)
    try {
      await issue(c.env, u, "reset", origin(c.env, c.req.raw));
    } catch {
      console.error("Password reset email unavailable");
    }
  return c.json({ ok: true });
});
auth.post("/verify", async (c) => {
  await rate(c, "verify", 20);
  const { token: t } = z
    .object({ token: z.string().length(64) })
    .parse(await c.req.json());
  const row = await c.env.DB.prepare(
    "DELETE FROM auth_tokens WHERE token_hash=? AND kind='verify' AND expires_at>? RETURNING user_id",
  )
    .bind(await sha(t), now())
    .first<{ user_id: string }>();
  if (!row)
    throw new HTTPException(400, {
      message: "Линкът е изтекъл или вече е използван.",
    });
  await c.env.DB.prepare("UPDATE users SET verified=1 WHERE id=?")
    .bind(row.user_id)
    .run();
  return c.json({ ok: true });
});
auth.post("/resend", async (c) => {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Влезте в профила си." });
  await rate(c, "resend", 3, 3600, user.id);
  if (!user.verified)
    await issue(c.env, user, "verify", origin(c.env, c.req.raw));
  return c.json({ ok: true });
});
auth.post("/reset", async (c) => {
  await rate(c, "reset", 10);
  const d = z
    .object({
      token: z.string().length(64),
      password: z.string().min(10).max(128),
    })
    .parse(await c.req.json());
  const hash = await hashPassword(d.password);
  const t = await sha(d.token);
  const row = await c.env.DB.prepare(
    "SELECT user_id FROM auth_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?",
  )
    .bind(t, now())
    .first<{ user_id: string }>();
  if (!row)
    throw new HTTPException(400, {
      message: "Линкът е изтекъл или вече е използван.",
    });
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash=? WHERE id=? AND EXISTS(SELECT 1 FROM auth_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?)",
    ).bind(hash, row.user_id, t, now()),
    c.env.DB.prepare("DELETE FROM auth_tokens WHERE user_id=?").bind(
      row.user_id,
    ),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(row.user_id),
  ]);
  if (!result[0].meta.changes)
    throw new HTTPException(400, { message: "Линкът вече е използван." });
  return c.json({ ok: true });
});
export const isAdmin = (env: Env, u: DbUser) =>
  !!u.verified &&
  (env.ADMIN_EMAILS || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .includes(u.email.toLowerCase());
