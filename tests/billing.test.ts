import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { database } from "./helpers";
import { webhook, allowance, mailbox } from "../server/billing";
import { now } from "../server/types";
const stripe = new Stripe("sk_test_local_only", {
  httpClient: Stripe.createFetchHttpClient(),
});
const secret = "whsec_local_test_only";
let env: any, sqlite: ReturnType<typeof database>["sqlite"];
function subscription(overrides: any = {}) {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: "si_1",
          price: { id: "price_creator" },
          current_period_start: 100,
          current_period_end: now() + 100000,
        },
      ],
    },
    latest_invoice: { id: "in_1", status: "paid" },
    ...overrides,
  };
}
async function event(type: string, object: any, id = "evt_1", created = now()) {
  const body = JSON.stringify({
    id,
    type,
    object: "event",
    created,
    data: { object },
  });
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload: body,
    secret,
  });
  return new Request("https://test.invalid/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body,
  });
}
beforeEach(() => {
  const d = database();
  sqlite = d.sqlite;
  sqlite.exec(
    "INSERT INTO users VALUES('u','u@test.invalid','Тест','hash',1,'cus_1',1)",
  );
  env = {
    DB: d.db,
    STRIPE_SECRET_KEY: "sk_test_local_only",
    STRIPE_WEBHOOK_SECRET: secret,
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_CREATOR: "price_creator",
    STRIPE_PRICE_STUDIO: "price_studio",
  };
});
afterEach(() => vi.unstubAllGlobals());
describe("Signed Stripe lifecycle", () => {
  it("rejects forged signatures before touching subscriptions", async () => {
    await expect(
      webhook(
        new Request("https://test.invalid/api/billing/webhook", {
          method: "POST",
          headers: { "stripe-signature": "bad" },
          body: "{}",
        }),
        env,
      ),
    ).rejects.toThrow("Невалиден подпис");
    expect(
      sqlite.prepare("SELECT COUNT(*) n FROM billing_events").get()?.n,
    ).toBe(0);
  });
  it("activates paid subscriptions once, preserves credits for duplicate events and resets at renewal", async () => {
    let sub = subscription();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(sub), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await webhook(
      await event("invoice.paid", {
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
      env,
    );
    const u = sqlite.prepare("SELECT * FROM users").get() as any;
    const a = await allowance(env, u);
    expect(a.plan).toBe("creator");
    expect(a.limit).toBe(100000);
    sqlite
      .prepare("UPDATE usage_windows SET used=1000 WHERE id=?")
      .run(a.window);
    await webhook(await event("invoice.paid", { subscription: "sub_1" }), env);
    expect((await allowance(env, u)).used).toBe(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    sub = subscription({
      items: {
        data: [
          {
            id: "si_1",
            price: { id: "price_creator" },
            current_period_start: 200,
            current_period_end: now() + 200000,
          },
        ],
      },
    });
    await webhook(
      await event(
        "invoice.paid",
        { subscription: "sub_1" },
        "evt_renew",
        now() + 1,
      ),
      env,
    );
    expect((await allowance(env, u)).used).toBe(0);
  });
  it("does not grant credits for unpaid invoices and revokes canceled subscriptions", async () => {
    let sub = subscription({
      latest_invoice: { id: "in_open", status: "open" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(sub), {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await webhook(
      await event("customer.subscription.updated", { id: "sub_1" }),
      env,
    );
    const u = sqlite.prepare("SELECT * FROM users").get() as any;
    expect((await allowance(env, u)).plan).toBe("free");
    sub = subscription({ status: "canceled" });
    await webhook(
      await event(
        "customer.subscription.deleted",
        { id: "sub_1" },
        "evt_cancel",
        now() + 1,
      ),
      env,
    );
    expect((await allowance(env, u)).hasSubscription).toBe(false);
  });
  it("orders writes by when Stripe was read, so an older reading never overwrites a newer one", async () => {
    let sub: any = subscription({ status: "canceled" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sub), { headers: { "Content-Type": "application/json" } })));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(2_000_000_000_000);
      await webhook(await event("customer.subscription.deleted", { id: "sub_1" }, "evt_new", 500), env);
      // A request that read Stripe earlier finishes later: it must not bring the subscription back.
      vi.setSystemTime(1_999_999_990_000);
      sub = subscription();
      await webhook(await event("customer.subscription.updated", { id: "sub_1" }, "evt_old", 400), env);
      expect(sqlite.prepare("SELECT status FROM subscriptions").get()?.status).toBe("canceled");
    } finally { vi.useRealTimers(); }
  });
  it("applies invoice.paid after a return-from-checkout sync saw the invoice still open", async () => {
    // Sync (on return from Checkout) reads an unpaid first invoice; the invoice.paid event was created just before.
    let sub: any = subscription({ latest_invoice: { id: "in_1", status: "open", billing_reason: "subscription_create" } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sub), { headers: { "Content-Type": "application/json" } })));
    await webhook(await event("customer.subscription.created", { id: "sub_1" }, "evt_created"), env);
    const u = sqlite.prepare("SELECT * FROM users").get() as any;
    expect((await allowance(env, u)).plan).toBe("free");
    sub = subscription();
    await webhook(await event("invoice.paid", { subscription: "sub_1" }, "evt_paid", now() - 5), env);
    expect((await allowance(env, u)).plan).toBe("creator");
  });
  it("keeps the paid plan while an upgrade invoice is being paid, then adds the unused share of the new plan", async () => {
    // Half of the period is left when the customer upgrades from Създател (100 000) to Студио (250 000).
    const start = now() - 15 * 86400, end = now() + 15 * 86400;
    let sub: any = subscription({ items: { data: [{ id: "si_1", price: { id: "price_creator" }, current_period_start: start, current_period_end: end }] } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sub), { headers: { "Content-Type": "application/json" } })));
    await webhook(await event("invoice.paid", { subscription: "sub_1" }), env);
    const u = sqlite.prepare("SELECT * FROM users").get() as any;
    expect((await allowance(env, u)).plan).toBe("creator");
    const upgraded = { data: [{ id: "si_1", price: { id: "price_studio" }, current_period_start: start, current_period_end: end }] };
    sub = subscription({ items: upgraded, latest_invoice: { id: "in_up", status: "open", billing_reason: "subscription_update" } });
    await webhook(await event("customer.subscription.updated", { id: "sub_1" }, "evt_up", now() + 1), env);
    // Not dropped to the trial while the upgrade invoice is open.
    expect((await allowance(env, u)).plan).toBe("creator");
    sub = subscription({ items: upgraded, latest_invoice: { id: "in_up", status: "paid", billing_reason: "subscription_update" } });
    await webhook(await event("invoice.paid", { subscription: "sub_1" }, "evt_up_paid", now() + 2), env);
    const a = await allowance(env, u);
    expect(a.plan).toBe("studio");
    expect(a.limit).toBeGreaterThan(174000); expect(a.limit).toBeLessThan(176000);
    // Asking again does not add more; the next period starts with the full allowance.
    expect((await allowance(env, u)).limit).toBe(a.limit);
  });
  it("keeps the paid plan while Stripe retries a failed renewal, and reports the payment problem", async () => {
    let sub: any = subscription({ items: { data: [{ id: "si_1", price: { id: "price_creator" }, current_period_start: 100, current_period_end: now() - 3600 }] } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sub), { headers: { "Content-Type": "application/json" } })));
    await webhook(await event("invoice.paid", { subscription: "sub_1" }), env);
    const u = sqlite.prepare("SELECT * FROM users").get() as any;
    const next = { data: [{ id: "si_1", price: { id: "price_creator" }, current_period_start: now() - 3600, current_period_end: now() + 30 * 86400 }] };
    sub = subscription({ status: "past_due", items: next, latest_invoice: { id: "in_2", status: "open", billing_reason: "subscription_cycle" } });
    await webhook(await event("invoice.payment_failed", { subscription: "sub_1" }, "evt_fail", now() + 1), env);
    const a = await allowance(env, u);
    expect(a).toMatchObject({ plan: "creator", paymentIssue: true, hasSubscription: true });
    sub = subscription({ items: next, latest_invoice: { id: "in_2", status: "paid", billing_reason: "subscription_cycle" } });
    await webhook(await event("invoice.paid", { subscription: "sub_1" }, "evt_paid", now() + 2), env);
    expect(await allowance(env, u)).toMatchObject({ plan: "creator", paymentIssue: false });
  });
  it("reports a price that is not a configured plan instead of silently ignoring it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const sub = subscription({ items: { data: [{ id: "si_1", price: { id: "price_other" }, current_period_start: 100, current_period_end: now() + 100 }] } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sub), { headers: { "Content-Type": "application/json" } })));
    await webhook(await event("customer.subscription.updated", { id: "sub_1" }), env);
    expect(log).toHaveBeenCalledWith("Subscription price is not a configured plan", { subscription: "sub_1", price: "price_other" });
    log.mockRestore();
  });
  it("maps replaced prices by lookup key and still records the cancellation of an unknown price", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const on = (price: any, extra: any = {}) => subscription({ items: { data: [{ id: "si_1", price, current_period_start: 100, current_period_end: now() + 100000 }] }, ...extra });
    let sub: any = on({ id: "price_old_studio", lookup_key: "studio" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sub), { headers: { "Content-Type": "application/json" } })));
    await webhook(await event("customer.subscription.updated", { id: "sub_1" }, "evt_a"), env);
    const u = sqlite.prepare("SELECT * FROM users").get() as any;
    expect((await allowance(env, u)).plan).toBe("studio");
    sub = on({ id: "price_unknown" }, { status: "canceled" });
    await webhook(await event("customer.subscription.deleted", { id: "sub_1" }, "evt_b"), env);
    expect(sqlite.prepare("SELECT plan,status FROM subscriptions").get()).toEqual({ plan: "studio", status: "canceled" });
    expect((await allowance(env, u)).plan).toBe("free");
    log.mockRestore();
  });
});
describe("free trial", () => {
  it("is once per mailbox: +tags and Gmail dots do not make a new one", async () => {
    expect(mailbox(" Ivan.Petrov+promo@GoogleMail.com")).toBe("ivanpetrov@gmail.com");
    expect(mailbox("ivan.petrov+x@firma.bg")).toBe("ivan.petrov@firma.bg");
    sqlite.exec("INSERT INTO users VALUES('g1','ivan.petrov@gmail.com','A','hash',1,NULL,1); INSERT INTO users VALUES('g2','ivanpetrov+2@gmail.com','B','hash',1,NULL,1); INSERT INTO users VALUES('g3','maria@gmail.com','C','hash',1,NULL,1)");
    const user = (id: string) => sqlite.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
    const first = await allowance(env, user("g1"));
    expect(first.used).toBe(0);
    // The same account keeps its own trial.
    expect((await allowance(env, user("g1"))).used).toBe(0);
    const alias = await allowance(env, user("g2"));
    expect(alias.used).toBe(alias.limit);
    expect((await allowance(env, user("g3"))).used).toBe(0);
  });
});
