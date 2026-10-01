import Stripe from "stripe";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { plans, type PlanId } from "../shared/catalog";
import type { Env, ContextVars, DbUser } from "./types";
import { now, ready, uid, DAY } from "./types";
import { origin, rate, sha } from "./security";
import { z } from "zod";
export const billing = new Hono<{ Bindings: Env; Variables: ContextVars }>();
export function stripe(env: Env) {
  if (!env.STRIPE_SECRET_KEY)
    throw new HTTPException(503, {
      message: "Плащанията все още не са активирани.",
    });
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
}
export const RENEWAL_GRACE = 3 * DAY;
export const paidPlans = ["starter", "creator", "studio"] as const;
/** Subscriptions an administrator granted (testers, partners): no Stripe behind them, see plan-grants.ts. */
export const GRANT_PREFIX = "grant_";
/** Identifies a trial across account deletion without keeping the address itself. */
export const trialKey = (email: string) => sha("trial:" + mailbox(email));
/** One mailbox, however it is written: "+tags" are ignored, and Gmail also ignores dots in the name. */
export function mailbox(email: string) {
  const [name, domain = ""] = email.trim().toLowerCase().split(/@(?=[^@]*$)/);
  const gmail = domain === "gmail.com" || domain === "googlemail.com";
  const base = name.replace(/\+.*$/, "");
  return `${gmail ? base.replace(/\./g, "") : base}@${gmail ? "gmail.com" : domain}`;
}
function priceIds(e: Env): Record<(typeof paidPlans)[number], string | undefined> {
  return {
    starter: e.STRIPE_PRICE_STARTER,
    creator: e.STRIPE_PRICE_CREATOR,
    studio: e.STRIPE_PRICE_STUDIO,
  };
}
export async function allowance(e: Env, u: DbUser) {
  // Ended grants never count. A running grant wins over a paid subscription unless the customer pays for a higher
  // plan (a tester on Начало gets the granted plan; someone who then buys Студио gets Студио).
  const rows = (await e.DB.prepare(
    "SELECT * FROM subscriptions WHERE user_id=?1 AND status IN ('active','trialing','past_due','unpaid','incomplete') AND NOT (substr(id,1,6)=?2 AND period_end<=?3) ORDER BY status='active' DESC, period_end DESC LIMIT 10",
  )
    .bind(u.id, GRANT_PREFIX, now())
    .all<any>()).results;
  const rank = (plan: string) => plans.findIndex((p) => p.id === plan);
  const grant = rows.find((r) => String(r.id).startsWith(GRANT_PREFIX));
  const paid = rows.find((r) => !String(r.id).startsWith(GRANT_PREFIX));
  const paidActive = paid?.status === "active" && paid.period_end + (paid.cancel_at_period_end ? 0 : RENEWAL_GRACE) > now();
  const sub = grant && !(paidActive && rank(paid.plan) > rank(grant.plan)) ? grant : paid || null;
  const granted = !!sub && sub === grant;
  // A renewing subscription keeps its last paid period until Stripe confirms the new invoice.
  const active =
    sub &&
    sub.status === "active" &&
    sub.period_end + (sub.cancel_at_period_end ? 0 : RENEWAL_GRACE) > now();
  const plan =
    plans.find((p) => p.id === (active ? sub.plan : "free")) || plans[0];
  const window = active
    ? `${u.id}:${sub.id}:${sub.period_start}`
    : `${u.id}:trial`;
  // Same plan: keep the window's quota (a manual increase, or a prorated upgrade, stays). A downgrade inside a period uses the new plan's allowance; an
  // upgrade adds only the unused share of the difference, so upgrading on the last day does not unlock a full
  // month of the bigger plan for a small prorated charge.
  // A new trial window starts from what a deleted account with the same email already used.
  const left = active && !granted && sub.period_end > sub.period_start
    ? Math.min(1, Math.max(0, (sub.period_end - now()) / (sub.period_end - sub.period_start))) : 1;
  const trial = await trialKey(u.email);
  const newTrial = !active && !(await e.DB.prepare("SELECT 1 FROM usage_windows WHERE id=?").bind(window).first());
  await e.DB.prepare(
    "INSERT INTO usage_windows(id,user_id,quota,plan,used) VALUES (?1,?2,?3,?4,CASE WHEN ?4='free' THEN COALESCE((SELECT used FROM trial_history WHERE email_hash=?5),0) ELSE 0 END) ON CONFLICT(id) DO UPDATE SET quota=CASE WHEN usage_windows.plan IS NULL THEN MAX(usage_windows.quota,excluded.quota) WHEN usage_windows.plan=excluded.plan THEN usage_windows.quota WHEN excluded.quota>usage_windows.quota THEN usage_windows.quota+CAST((excluded.quota-usage_windows.quota)*?6 AS INTEGER) ELSE excluded.quota END,plan=excluded.plan",
  )
    .bind(window, u.id, plan.chars, plan.id, trial, left)
    .run();
  // The free trial is once per mailbox: another account of the same address (user+1@…) starts with it used up.
  if (newTrial)
    await e.DB.prepare("INSERT INTO trial_history(email_hash,used) VALUES (?,?) ON CONFLICT(email_hash) DO UPDATE SET used=MAX(trial_history.used,excluded.used)")
      .bind(trial, plan.chars).run();
  const usage = await e.DB.prepare(
    "SELECT used,quota FROM usage_windows WHERE id=?",
  )
    .bind(window)
    .first<{ used: number; quota: number }>();
  return {
    plan: plan.id,
    used: usage?.used || 0,
    limit: usage?.quota || plan.chars,
    window,
    periodEnd: active ? sub.period_end : null,
    // Only a Stripe subscription can be managed in the Customer Portal.
    hasSubscription: granted
      ? !!(await e.DB.prepare("SELECT id FROM subscriptions WHERE user_id=? AND substr(id,1,6)!=? AND status IN ('active','trialing','past_due','unpaid','incomplete') LIMIT 1").bind(u.id, GRANT_PREFIX).first())
      : !!sub,
    /** The plan is an administrator's grant (until periodEnd), not a paid subscription. */
    granted: granted && !!active,
    /** A paid subscription whose latest payment has not gone through (renewal grace or already lapsed). */
    paymentIssue: !!paid && !granted && (paid.status !== "active" || paid.period_end < now()),
  };
}
billing.post("/checkout", async (c) => {
  const u = c.get("user");
  if (!u.verified)
    throw new HTTPException(403, {
      message: "Потвърдете имейла си преди плащане.",
    });
  if (c.env.BILLING_ENABLED !== "true" || !ready(c.env))
    throw new HTTPException(503, {
      message: "Абонаментите все още не са активирани.",
    });
  await rate(c, "checkout", 8, 3600, u.id);
  const parsed = z.object({ plan: z.enum(paidPlans) }).safeParse(await c.req.json());
  const requested = parsed.success ? parsed.data.plan : null;
  let id = requested && priceIds(c.env)[requested];
  if (!requested || !id)
    throw new HTTPException(400, { message: "Невалиден или неактивен план." });
  const s = stripe(c.env);
  let customer = u.stripe_customer;
  if (!customer) {
    const created = await s.customers.create(
      { email: u.email, name: u.name, metadata: { user_id: u.id } },
      { idempotencyKey: "rech-customer-" + u.id },
    );
    customer = created.id;
    await c.env.DB.prepare("UPDATE users SET stripe_customer=? WHERE id=?")
      .bind(customer, u.id)
      .run();
  }
  const existing = await s.subscriptions.list({
    customer,
    status: "all",
    limit: 100,
  });
  if (
    existing.data.some(
      (x) => !["canceled", "incomplete_expired"].includes(x.status),
    )
  )
    return c.json({ url: await portalUrl(c.env, c.req.raw, customer, requested) });
  await c.env.DB.prepare(
    "INSERT INTO checkout_intents(user_id,plan,intent_id,expires_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,intent_id=excluded.intent_id,expires_at=excluded.expires_at WHERE checkout_intents.expires_at<?",
  )
    .bind(u.id, requested, uid(), now() + 1860, now())
    .run();
  const intent = await c.env.DB.prepare(
    "SELECT * FROM checkout_intents WHERE user_id=?",
  )
    .bind(u.id)
    .first<any>();
  if (intent.plan !== requested) {
    // Close the checkout for the earlier choice so only one subscription can ever be started.
    const open = await s.checkout.sessions.list({ customer, status: "open", limit: 100 });
    for (const session of open.data) await s.checkout.sessions.expire(session.id);
    intent.plan = requested;
    intent.intent_id = uid();
    await c.env.DB.prepare(
      "UPDATE checkout_intents SET plan=?,intent_id=? WHERE user_id=?",
    )
      .bind(intent.plan, intent.intent_id, u.id)
      .run();
  }
  const plan = intent.plan as (typeof paidPlans)[number];
  id = priceIds(c.env)[plan];
  if (!id)
    throw new HTTPException(503, { message: "Планът временно не е достъпен." });
  const p = await s.prices.retrieve(id);
  const chosen = plans.find((p) => p.id === plan)!;
  if (
    !p.active ||
    p.currency !== "eur" ||
    p.unit_amount !== chosen.price * 100 ||
    p.recurring?.interval !== "month" ||
    p.recurring.interval_count !== 1 ||
    p.tax_behavior !== "inclusive"
  )
    throw new HTTPException(503, {
      message: "Настройката на този план се актуализира. Опитайте по-късно.",
    });
  const session = await s.checkout.sessions.create(
    {
      mode: "subscription",
      customer,
      expires_at: intent.expires_at,
      line_items: [{ price: id, quantity: 1 }],
      allow_promotion_codes: true,
      billing_address_collection: "required",
      tax_id_collection: { enabled: true },
      automatic_tax: { enabled: true },
      customer_update: { address: "auto", name: "auto" },
      locale: "bg",
      client_reference_id: u.id,
      metadata: { user_id: u.id },
      subscription_data: { metadata: { user_id: u.id } },
      success_url: origin(c.env, c.req.raw) + "/app/billing?success=1",
      cancel_url: origin(c.env, c.req.raw) + "/app/billing?cancelled=1",
    },
    { idempotencyKey: `rech-checkout-${intent.intent_id}-${id}` },
  );
  return c.json({ url: session.url });
});
/**
 * Re-reads the customer's subscriptions from Stripe, e.g. on return from Checkout or the Customer Portal,
 * so a plan change shows at once even if its webhook is late or was missed.
 */
billing.post("/sync", async (c) => {
  const u = c.get("user");
  if (!u.stripe_customer) return c.json({ ok: true });
  await rate(c, "billing-sync", 30, 3600, u.id);
  const fetchedAt = now();
  const list = await stripe(c.env).subscriptions.list({ customer: u.stripe_customer, status: "all", limit: 10, expand: ["data.latest_invoice"] });
  const statements: D1PreparedStatement[] = [];
  for (const sub of list.data) statements.push(...(await subscriptionStatements(c.env, sub, u.id, fetchedAt)));
  if (statements.length) await c.env.DB.batch(statements);
  return c.json({ ok: true });
});
/**
 * Nightly backstop for missed webhooks: re-reads from Stripe the customers whose plan looks doubtful — a paid
 * period that ended without renewal, a payment problem, or a checkout with no active subscription after it.
 */
export async function reconcileStripe(e: Env) {
  if (e.BILLING_ENABLED !== "true" || !ready(e)) return;
  const users = (await e.DB.prepare(
    `SELECT u.id,u.stripe_customer FROM users u WHERE u.stripe_customer IS NOT NULL AND (
      EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=u.id AND substr(s.id,1,6)<>?1 AND ((s.status='active' AND s.period_end<?2) OR s.status IN ('past_due','incomplete','trialing','unpaid')))
      OR (EXISTS(SELECT 1 FROM checkout_intents c WHERE c.user_id=u.id AND c.expires_at>?2-2*86400) AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=u.id AND substr(s.id,1,6)<>?1 AND s.status='active'))
    ) LIMIT 50`,
  ).bind(GRANT_PREFIX, now()).all<{ id: string; stripe_customer: string }>()).results;
  let changed = 0;
  for (const u of users) {
    try {
      const fetchedAt = now();
      const list = await stripe(e).subscriptions.list({ customer: u.stripe_customer, status: "all", limit: 10, expand: ["data.latest_invoice"] });
      const statements: D1PreparedStatement[] = [];
      for (const sub of list.data) statements.push(...(await subscriptionStatements(e, sub, u.id, fetchedAt)));
      if (statements.length) { await e.DB.batch(statements); changed++; }
    } catch (error) {
      console.error("Stripe reconciliation failed", { userId: u.id, error: (error as Error)?.name });
    }
  }
  if (users.length) console.log("Stripe reconciliation", { checked: users.length, updated: changed });
}
/**
 * A Customer Portal link. With a plan, it opens straight on the confirmation of that plan change and
 * returns to the app by itself once confirmed (the plain portal only shows a "back" link, so people stayed
 * in Stripe and the app never refreshed). Falls back to the plain portal if the flow is not possible.
 */
async function portalUrl(e: Env, request: Request, customer: string, plan?: (typeof paidPlans)[number] | null) {
  const s = stripe(e), back = origin(e, request) + "/app/billing?portal=1";
  const price = plan ? priceIds(e)[plan] : undefined;
  if (price) {
    try {
      const sub = (await s.subscriptions.list({ customer, status: "active", limit: 1 })).data[0];
      const item = sub?.items.data[0];
      if (sub && item && sub.items.data.length === 1 && item.price.id !== price)
        return (await s.billingPortal.sessions.create({
          customer, return_url: back,
          flow_data: {
            type: "subscription_update_confirm",
            subscription_update_confirm: { subscription: sub.id, items: [{ id: item.id, price, quantity: 1 }] },
            after_completion: { type: "redirect", redirect: { return_url: back } },
          },
        })).url;
    } catch {
      console.error("Plan change flow unavailable; opening the Customer Portal", { plan });
    }
  }
  return (await s.billingPortal.sessions.create({ customer, return_url: back })).url;
}
billing.post("/portal", async (c) => {
  const u = c.get("user");
  if (!u.stripe_customer)
    throw new HTTPException(400, {
      message: "Все още нямате платен абонамент.",
    });
  // Each call creates a Stripe portal session; a loop must not run up Stripe API usage.
  await rate(c, "billing-portal", 20, 3600, u.id);
  const body = await c.req.json().catch(() => ({}));
  const plan = z.object({ plan: z.enum(paidPlans) }).safeParse(body);
  return c.json({ url: await portalUrl(c.env, c.req.raw, u.stripe_customer, plan.success ? plan.data.plan : null) });
});
/** The plan of a Stripe price: a configured STRIPE_PRICE_*, or (for older/replaced prices) its lookup key or metadata.plan. */
function planOf(e: Env, price: Stripe.Price | undefined): PlanId | undefined {
  if (!price) return undefined;
  const configured = Object.entries(priceIds(e)).find(([, v]) => v === price.id)?.[0];
  const named = [price.lookup_key, price.metadata?.plan].find((p) => (paidPlans as readonly string[]).includes(p || ""));
  return (configured || named || undefined) as PlanId | undefined;
}
/**
 * Stores Stripe's current state of a subscription (read from Stripe, never from an event payload).
 * `fetchedAt` (taken just before reading from Stripe) orders writes: an older reading never overwrites a newer one.
 */
async function subscriptionStatements(e: Env, sub: Stripe.Subscription, userId: string, fetchedAt: number) {
  const item = sub.items.data[0];
  const plan = planOf(e, item?.price);
  if (!plan) {
    // Must be visible: e.g. a price offered in the Customer Portal that is not one of the configured plans.
    console.error("Subscription price is not a configured plan", { subscription: sub.id, price: item?.price.id });
    // Its status and period are still kept current (a cancellation must land); the stored plan stays.
    return item ? [e.DB.prepare(
      "UPDATE subscriptions SET status=?,period_start=?,period_end=?,cancel_at_period_end=?,event_created=? WHERE id=? AND ?>=event_created",
    ).bind(sub.status, item.current_period_start, item.current_period_end, sub.cancel_at_period_end ? 1 : 0, fetchedAt, sub.id, fetchedAt)] : [];
  }
  const invoice = sub.latest_invoice as Stripe.Invoice | null;
  const unpaid = sub.status === "active" && (!invoice || typeof invoice !== "object" || invoice.status !== "paid");
  // A renewal or plan-change invoice is draft/open for a moment. Keep the stored, paid state (allowance()
  // grants a grace period on renewal) until it is paid, instead of dropping the customer to the trial.
  // Stripe marks a subscription past_due at the first failed attempt and keeps retrying the card for days.
  const pending = (unpaid || sub.status === "past_due") && typeof invoice === "object" &&
    ["subscription_cycle", "subscription_update"].includes(invoice?.billing_reason || "") &&
    !!(await e.DB.prepare("SELECT id FROM subscriptions WHERE id=? AND status='active'").bind(sub.id).first());
  if (pending) return [];
  return [e.DB.prepare(
    "INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_created=excluded.event_created WHERE excluded.event_created>=subscriptions.event_created",
  ).bind(sub.id, userId, plan, unpaid ? "past_due" : sub.status, item.current_period_start, item.current_period_end, sub.cancel_at_period_end ? 1 : 0, fetchedAt)];
}
export async function webhook(request: Request, e: Env) {
  if (!e.STRIPE_WEBHOOK_SECRET)
    throw new HTTPException(503, { message: "Плащанията не са настроени." });
  const s = stripe(e);
  let event: Stripe.Event;
  try {
    event = await s.webhooks.constructEventAsync(
      await request.text(),
      request.headers.get("stripe-signature") || "",
      e.STRIPE_WEBHOOK_SECRET,
      300,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    throw new HTTPException(400, { message: "Невалиден подпис." });
  }
  if (
    await e.DB.prepare("SELECT id FROM billing_events WHERE id=?")
      .bind(event.id)
      .first()
  )
    return { received: true };
  let subscriptionId: string | undefined;
  const object = event.data.object as any;
  if (event.type.startsWith("customer.subscription."))
    subscriptionId = object.id;
  else if (event.type === "checkout.session.completed")
    subscriptionId =
      typeof object.subscription === "string"
        ? object.subscription
        : object.subscription?.id;
  else if (["invoice.paid", "invoice.payment_failed"].includes(event.type))
    subscriptionId =
      object.parent?.subscription_details?.subscription || object.subscription;
  const statements: D1PreparedStatement[] = [];
  if (subscriptionId) {
    // Fetch current state: do not grant access based on a redirect, stale event payload or invoice alone.
    const fetchedAt = now();
    const sub = await s.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice"],
    });
    const customer =
      typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const user = await e.DB.prepare(
      "SELECT id FROM users WHERE stripe_customer=?",
    )
      .bind(customer)
      .first<{ id: string }>();
    if (
      !user &&
      sub.metadata?.user_id &&
      !["canceled", "incomplete_expired"].includes(sub.status) &&
      !(await e.DB.prepare("SELECT id FROM users WHERE id=?")
        .bind(sub.metadata.user_id)
        .first())
    ) {
      // Started by an account that no longer exists (for example, paid after deletion): nobody can use or cancel it.
      await s.subscriptions.cancel(sub.id);
      console.error("Cancelled subscription of a deleted account; review for refund", {
        subscription: sub.id,
      });
    }
    if (user) statements.push(...(await subscriptionStatements(e, sub, user.id, fetchedAt)));
  }
  statements.push(
    e.DB.prepare(
      "INSERT OR IGNORE INTO billing_events(id,created_at) VALUES (?,?)",
    ).bind(event.id, now()),
  );
  await e.DB.batch(statements);
  return { received: true };
}
