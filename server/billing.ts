import Stripe from "stripe";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { plans, type PlanId } from "../shared/catalog";
import type { Env, ContextVars, DbUser } from "./types";
import { now, ready, uid } from "./types";
import { origin, rate } from "./security";
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
function priceIds(e: Env): Record<string, string | undefined> {
  return {
    starter: e.STRIPE_PRICE_STARTER,
    creator: e.STRIPE_PRICE_CREATOR,
    studio: e.STRIPE_PRICE_STUDIO,
  };
}
export async function allowance(e: Env, u: DbUser) {
  const sub = await e.DB.prepare(
    "SELECT * FROM subscriptions WHERE user_id=? AND status IN ('active','trialing','past_due','unpaid','incomplete') ORDER BY period_end DESC LIMIT 1",
  )
    .bind(u.id)
    .first<any>();
  const active = sub && sub.status === "active" && sub.period_end > now();
  const plan =
    plans.find((p) => p.id === (active ? sub.plan : "free")) || plans[0];
  const window = active
    ? `${u.id}:${sub.id}:${sub.period_start}`
    : `${u.id}:trial`;
  await e.DB.prepare(
    "INSERT INTO usage_windows(id,user_id,quota) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET quota=MAX(quota,excluded.quota)",
  )
    .bind(window, u.id, plan.chars)
    .run();
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
    hasSubscription: !!sub,
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
  let { plan } = await c.req.json();
  let id = priceIds(c.env)[plan];
  if (!id)
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
    return c.json({
      url: (
        await s.billingPortal.sessions.create({
          customer,
          return_url: origin(c.env, c.req.raw) + "/app/billing",
        })
      ).url,
    });
  await c.env.DB.prepare(
    "INSERT INTO checkout_intents(user_id,plan,intent_id,expires_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,intent_id=excluded.intent_id,expires_at=excluded.expires_at WHERE checkout_intents.expires_at<?",
  )
    .bind(u.id, plan, uid(), now() + 1860, now())
    .run();
  const intent = await c.env.DB.prepare(
    "SELECT * FROM checkout_intents WHERE user_id=?",
  )
    .bind(u.id)
    .first<any>();
  plan = intent.plan;
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
    { idempotencyKey: `rech-checkout-${intent.intent_id}` },
  );
  return c.json({ url: session.url });
});
billing.post("/portal", async (c) => {
  const u = c.get("user");
  if (!u.stripe_customer)
    throw new HTTPException(400, {
      message: "Все още нямате платен абонамент.",
    });
  return c.json({
    url: (
      await stripe(c.env).billingPortal.sessions.create({
        customer: u.stripe_customer,
        return_url: origin(c.env, c.req.raw) + "/app/billing",
      })
    ).url,
  });
});
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
    if (user) {
      const item = sub.items.data[0];
      const plan = Object.entries(priceIds(e)).find(
        ([, v]) => v === item?.price.id,
      )?.[0] as PlanId | undefined;
      const invoice = sub.latest_invoice as Stripe.Invoice | null;
      const status =
        sub.status === "active" &&
        (!invoice || typeof invoice !== "object" || invoice.status !== "paid")
          ? "past_due"
          : sub.status;
      if (plan)
        statements.push(
          e.DB.prepare(
            "INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_created=excluded.event_created WHERE excluded.event_created>=subscriptions.event_created",
          ).bind(
            sub.id,
            user.id,
            plan,
            status,
            item.current_period_start,
            item.current_period_end,
            sub.cancel_at_period_end ? 1 : 0,
            event.created,
          ),
        );
    }
  }
  statements.push(
    e.DB.prepare(
      "INSERT OR IGNORE INTO billing_events(id,created_at) VALUES (?,?)",
    ).bind(event.id, now()),
  );
  await e.DB.batch(statements);
  return { received: true };
}
