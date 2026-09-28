import type { Env, ContextVars } from "../types";
import { Hono } from "hono";
import { hasActiveJob, hasActiveMediaTask } from "../db";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { now } from "../types";
import { rate, checkPassword, hashPassword } from "../security";
import { stripe, trialKey } from "../billing";
import { drainCleanup } from "../maintenance";
import { publicJob } from "./jobs";
/** Profile, password, data export and account deletion. */
export const settings = new Hono<{ Bindings: Env; Variables: ContextVars }>();
settings.put("/api/settings", async (c) => {
  const d = z
    .object({ name: z.string().trim().min(2).max(80) })
    .parse(await c.req.json());
  await c.env.DB.prepare("UPDATE users SET name=? WHERE id=?")
    .bind(d.name, c.get("user").id)
    .run();
  return c.json({ ok: true });
});
settings.post("/api/settings/password", async (c) => {
  const d = z
    .object({
      currentPassword: z.string().max(128),
      password: z.string().min(10).max(128),
    })
    .parse(await c.req.json());
  await rate(c, "password-change", 5, 3600, c.get("user").id);
  if (!(await checkPassword(d.currentPassword, c.get("user").password_hash)))
    throw new HTTPException(400, { message: "Текущата парола е неправилна." });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(
      await hashPassword(d.password),
      c.get("user").id,
    ),
    c.env.DB.prepare(
      "DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
    ).bind(c.get("user").id, c.get("session")),
    c.env.DB.prepare("DELETE FROM auth_tokens WHERE user_id=?").bind(
      c.get("user").id,
    ),
  ]);
  return c.json({ ok: true });
});
settings.get("/api/settings/export", async (c) => {
  const u = c.get("user");
  const projects = (
    await c.env.DB.prepare("SELECT * FROM projects WHERE user_id=?")
      .bind(u.id)
      .all()
  ).results;
  const jobs = (
    await c.env.DB.prepare(
      "SELECT * FROM jobs WHERE user_id=?",
    )
      .bind(u.id)
      .all()
  ).results;
  const subscriptions = (
    await c.env.DB.prepare(
      "SELECT plan,status,period_start,period_end FROM subscriptions WHERE user_id=?",
    )
      .bind(u.id)
      .all()
  ).results;
  return new Response(
    JSON.stringify(
      {
        profile: { name: u.name, email: u.email, created_at: u.created_at },
        projects,
        jobs: jobs.map((j: any) => ({ ...publicJob(j), script: j.script, voice: j.voice, second_voice: j.second_voice })),
        subscriptions,
      },
      null,
      2,
    ),
    {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="rech-bg-data.json"',
      },
    },
  );
});
settings.delete("/api/settings/account", async (c) => {
  await rate(c, "account-delete", 5, 3600, c.get("user").id);
  const d = z
    .object({ password: z.string().max(128) })
    .parse(await c.req.json());
  const u = c.get("user");
  if (!(await checkPassword(d.password, u.password_hash)))
    throw new HTTPException(400, { message: "Паролата е неправилна." });
  if (u.stripe_customer) {
    const list = await stripe(c.env).subscriptions.list({
      customer: u.stripe_customer,
      status: "all",
      limit: 100,
    });
    if (
      list.data.some(
        (s) => !["canceled", "incomplete_expired"].includes(s.status),
      )
    )
      throw new HTTPException(409, {
        message:
          "Първо прекратете абонамента и изчакайте края на платения период.",
      });
    // An open checkout could still be paid after the account is gone. The webhook also cancels
    // any such subscription, but closing the sessions first keeps the customer from being charged.
    const open = await stripe(c.env).checkout.sessions.list({
      customer: u.stripe_customer,
      status: "open",
      limit: 100,
    });
    for (const session of open.data)
      await stripe(c.env).checkout.sessions.expire(session.id);
  }
  if (await hasActiveJob(c.env, u.id))
    throw new HTTPException(409, {
      message: "Изчакайте текущия запис да завърши.",
    });
  if (c.env.MEDIA_ENABLED === "true" && (await hasActiveMediaTask(c.env, u.id)))
    throw new HTTPException(409, { message: "Изчакайте медийната обработка да завърши." });
  const noActive =
    "NOT EXISTS(SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','running'))";
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT ?,? WHERE " +
        noActive,
    ).bind(`audio/${u.id}/`, now(), u.id),
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT ?,? WHERE " +
        noActive,
    ).bind(`segments/${u.id}/`, now(), u.id),
    c.env.DB.prepare(
      "INSERT INTO trial_history(email_hash,used) SELECT ?,used FROM usage_windows WHERE id=? AND " +
        noActive +
        " ON CONFLICT(email_hash) DO UPDATE SET used=MAX(trial_history.used,excluded.used)",
    ).bind(await trialKey(u.email), `${u.id}:trial`, u.id),
    c.env.DB.prepare("DELETE FROM users WHERE id=? AND " + noActive).bind(
      u.id,
      u.id,
    ),
  ]);
  if (!results[3].meta.changes)
    throw new HTTPException(409, {
      message: "Има активен запис. Изчакайте и опитайте отново.",
    });
  c.executionCtx.waitUntil(drainCleanup(c.env));
  return c.json({ ok: true });
});
