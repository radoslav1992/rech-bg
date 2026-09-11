import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { database } from "./helpers";
import { webhook, allowance } from "../server/billing";
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
  it("does not let older events overwrite a newer processed state", async () => {
    let sub = subscription({ status: "canceled" });
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
      await event(
        "customer.subscription.deleted",
        { id: "sub_1" },
        "evt_new",
        500,
      ),
      env,
    );
    sub = subscription();
    await webhook(
      await event(
        "customer.subscription.updated",
        { id: "sub_1" },
        "evt_old",
        400,
      ),
      env,
    );
    expect(
      sqlite.prepare("SELECT status FROM subscriptions").get()?.status,
    ).toBe("canceled");
  });
});
