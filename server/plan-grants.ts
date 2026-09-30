import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ContextVars, Env } from "./types";
import { now, uid } from "./types";
import { rate } from "./security";
import { GRANT_PREFIX, paidPlans } from "./billing";

// Administrator grants: a paid plan for one month without Stripe (testers, partners, support cases).
// A grant is a subscription row that ends on its own; its own id gives it a fresh monthly credit window.
export const GRANT_DAYS = 30;
export const planGrants = new Hono<{ Bindings: Env; Variables: ContextVars }>();

/** Grants that are running or ended in the last 90 days, newest first. */
planGrants.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id,s.plan,s.period_start AS start,s.period_end AS end,u.email,u.name,
      (SELECT COALESCE(SUM(w.used),0) FROM usage_windows w WHERE w.id=u.id||':'||s.id||':'||s.period_start) AS used
     FROM subscriptions s JOIN users u ON u.id=s.user_id
     WHERE substr(s.id,1,6)=? AND s.period_end>? ORDER BY s.period_start DESC LIMIT 100`,
  ).bind(GRANT_PREFIX, now() - 90 * 86400).all();
  return c.json({ grants: results, now: now() });
});

/** Gives a user a plan for one month. A running grant of that user is replaced (it starts again with full credits). */
planGrants.post("/", async (c) => {
  await rate(c, "plan-grant", 60, 3600, c.get("user").id);
  const d = z.object({ email: z.string().max(254).transform((s) => s.toLowerCase().trim()).pipe(z.email()), plan: z.enum(paidPlans) }).parse(await c.req.json());
  const user = await c.env.DB.prepare("SELECT id,email FROM users WHERE email=?").bind(d.email).first<{ id: string; email: string }>();
  if (!user) throw new HTTPException(404, { message: "Няма профил с този имейл. Потребителят трябва първо да се регистрира." });
  const t = now(), id = `${GRANT_PREFIX}${uid()}`;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE subscriptions SET period_end=? WHERE user_id=? AND substr(id,1,6)=? AND period_end>?").bind(t, user.id, GRANT_PREFIX, t),
    c.env.DB.prepare(
      "INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES (?,?,?,'active',?,?,1,?)",
    ).bind(id, user.id, d.plan, t, t + GRANT_DAYS * 86400, t),
  ]);
  // A paid subscription keeps billing in Stripe while the grant runs: the admin should know.
  const paid = await c.env.DB.prepare(
    "SELECT plan FROM subscriptions WHERE user_id=? AND substr(id,1,6)!=? AND status='active' AND period_end>? LIMIT 1",
  ).bind(user.id, GRANT_PREFIX, t).first<{ plan: string }>();
  console.log("Plan granted", { grant: id, plan: d.plan, by: c.get("user").id });
  return c.json({ id, end: t + GRANT_DAYS * 86400, paidPlan: paid?.plan ?? null }, 201);
});

/** Ends a grant now; the user returns to their paid plan or the free tier. */
planGrants.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id.startsWith(GRANT_PREFIX)) throw new HTTPException(404);
  const t = now();
  const r = await c.env.DB.prepare("UPDATE subscriptions SET period_end=? WHERE id=? AND period_end>?").bind(t, id, t).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Предоставянето вече е приключило." });
  return c.json({ ok: true });
});
