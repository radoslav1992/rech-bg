import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import worker, { maintenance } from "../server/index";
import { database } from "./helpers";
import { hashPassword, sha } from "../server/security";
import { allowance, webhook, RENEWAL_GRACE } from "../server/billing";
import { now } from "../server/types";
import { plans } from "../shared/catalog";

let env: any, sqlite: ReturnType<typeof database>["sqlite"];
const password = "correct-password-1";
beforeEach(async () => {
  const d = database();
  sqlite = d.sqlite;
  sqlite
    .prepare("INSERT INTO users VALUES('u','u@test.invalid','Тест',?,1,'cus_1',1)")
    .run(await hashPassword(password));
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("session"), now() + 3600);
  env = {
    DB: d.db,
    BILLING_ENABLED: "true",
    COMPANY_ID: "123",
    COMPANY_ADDRESS: "Sofia",
    STRIPE_SECRET_KEY: "sk_test_local_only",
    STRIPE_WEBHOOK_SECRET: "whsec_local_test_only",
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_CREATOR: "price_creator",
    STRIPE_PRICE_STUDIO: "price_studio",
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite.close();
});
const call = (path: string, method = "POST", body?: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request("https://rechbg.com/api" + path, {
      method,
      headers: { Origin: "https://rechbg.com", "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
    env,
    { waitUntil: () => {} } as any,
  );
const user = () => sqlite.prepare("SELECT * FROM users WHERE id='u'").get() as any;

describe("login limits", () => {
  const login = (pw: string, ip: string) =>
    call("/auth/login", "POST", { email: "u@test.invalid", password: pw }, { "CF-Connecting-IP": ip });
  it("counts only failures, and one address cannot lock the owner out", async () => {
    for (let i = 0; i < 10; i++) expect((await login("wrong-password-1", "10.0.0.1")).status).toBe(401);
    expect((await login(password, "10.0.0.1")).status).toBe(429);
    expect((await login(password, "10.0.0.2")).status).toBe(200);
    for (let i = 0; i < 12; i++) expect((await login(password, "10.0.0.3")).status).toBe(200);
  });
});

describe("password reset requests", () => {
  it("caps emails per address and answers identically for unknown addresses", async () => {
    const send = vi.fn().mockResolvedValue({});
    Object.assign(env, { EMAIL: { send }, EMAIL_FROM: "info@rechbg.com" });
    for (let i = 0; i < 5; i++) {
      const ip = { "CF-Connecting-IP": "10.1.0." + i };
      expect(await (await call("/auth/forgot", "POST", { email: "u@test.invalid" }, ip)).json()).toEqual({ ok: true });
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(await (await call("/auth/forgot", "POST", { email: "nobody@test.invalid" })).json()).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(3);
  });
});

describe("checkout", () => {
  const stripeMock = (requests: { method: string; url: string }[]) =>
    vi.fn(async (input: any, init: any) => {
      const url = String(input);
      requests.push({ method: init?.method || "GET", url });
      if (url.includes("/subscriptions")) return Response.json({ data: [] });
      if (url.includes("/prices/"))
        return Response.json({ active: true, currency: "eur", unit_amount: plans.find((p) => url.includes(p.id))!.price * 100, recurring: { interval: "month", interval_count: 1 }, tax_behavior: "inclusive" });
      if (url.includes("/checkout/sessions/cs_old/expire")) return Response.json({ id: "cs_old", status: "expired" });
      if (url.includes("/checkout/sessions?") || (url.endsWith("/checkout/sessions") && init?.method === "GET"))
        return Response.json({ object: "list", data: [{ id: "cs_old" }], has_more: false });
      return Response.json({ url: "https://checkout.stripe.com/" + requests.length });
    });
  const checkout = (plan: unknown) => call("/billing/checkout", "POST", { plan }, { Cookie: "rech_session=session" });
  it("rejects unknown and prototype plan names", async () => {
    vi.stubGlobal("fetch", vi.fn());
    for (const plan of ["constructor", "__proto__", "free", 1]) expect((await checkout(plan)).status).toBe(400);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM checkout_intents").get()!.n).toBe(0);
  });
  it("switching plans closes the earlier checkout and uses the new plan", async () => {
    const requests: { method: string; url: string }[] = [];
    vi.stubGlobal("fetch", stripeMock(requests));
    expect((await checkout("starter")).status).toBe(200);
    expect(requests.some((r) => r.url.includes("/expire"))).toBe(false);
    expect((await checkout("studio")).status).toBe(200);
    expect(requests.some((r) => r.url.includes("/checkout/sessions/cs_old/expire"))).toBe(true);
    expect(requests.some((r) => r.url.includes("/prices/price_studio"))).toBe(true);
    expect(sqlite.prepare("SELECT plan FROM checkout_intents").get()!.plan).toBe("studio");
  });
});

describe("usage windows", () => {
  const subscribe = (plan: string, periodEnd = now() + 1000) =>
    sqlite
      .prepare("INSERT INTO subscriptions VALUES('sub_1','u',?,'active',100,?,0,1) ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,period_end=excluded.period_end")
      .run(plan, periodEnd);
  it("lowers the quota on a mid-period downgrade but keeps manual grants on the same plan", async () => {
    subscribe("studio");
    const a = await allowance(env, user());
    expect(a.limit).toBe(250000);
    subscribe("starter");
    expect((await allowance(env, user())).limit).toBe(30000);
    sqlite.prepare("UPDATE usage_windows SET quota=50000 WHERE id=?").run(a.window);
    expect((await allowance(env, user())).limit).toBe(50000);
  });
  it("keeps the paid period during the renewal grace period only", async () => {
    subscribe("creator", now() - 60);
    expect((await allowance(env, user())).plan).toBe("creator");
    subscribe("creator", now() - RENEWAL_GRACE - 60);
    expect((await allowance(env, user())).plan).toBe("free");
  });
});

describe("Stripe webhooks", () => {
  const stripe = new Stripe("sk_test_local_only", { httpClient: Stripe.createFetchHttpClient() });
  async function event(type: string, object: any, id: string, created = now()) {
    const payload = JSON.stringify({ id, type, object: "event", created, data: { object } });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
    return new Request("https://rechbg.com/api/billing/webhook", { method: "POST", headers: { "stripe-signature": signature }, body: payload });
  }
  const subscription = (overrides: any = {}) => ({
    id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: false, metadata: { user_id: "u" },
    items: { data: [{ id: "si_1", price: { id: "price_creator" }, current_period_start: 100, current_period_end: now() + 1000 }] },
    latest_invoice: { id: "in_1", status: "paid", billing_reason: "subscription_create" },
    ...overrides,
  });
  it("does not revoke access while a renewal invoice is still open", async () => {
    let sub: any = subscription();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(sub)));
    await webhook(await event("invoice.paid", { subscription: "sub_1" }, "evt_1"), env);
    sub = subscription({
      items: { data: [{ id: "si_1", price: { id: "price_creator" }, current_period_start: 200, current_period_end: now() + 5000 }] },
      latest_invoice: { id: "in_2", status: "open", billing_reason: "subscription_cycle" },
    });
    await webhook(await event("customer.subscription.updated", { id: "sub_1" }, "evt_2", now() + 1), env);
    expect(sqlite.prepare("SELECT status,period_start FROM subscriptions").get()).toEqual({ status: "active", period_start: 100 });
    sub = subscription({
      items: { data: [{ id: "si_1", price: { id: "price_creator" }, current_period_start: 200, current_period_end: now() + 5000 }] },
      latest_invoice: { id: "in_2", status: "paid", billing_reason: "subscription_cycle" },
    });
    await webhook(await event("invoice.paid", { subscription: "sub_1" }, "evt_3", now() + 2), env);
    expect(sqlite.prepare("SELECT status,period_start FROM subscriptions").get()).toEqual({ status: "active", period_start: 200 });
  });
  it("still withholds access for an unpaid first invoice and after a failed renewal", async () => {
    let sub: any = subscription({ latest_invoice: { id: "in_1", status: "open", billing_reason: "subscription_create" } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(sub)));
    await webhook(await event("customer.subscription.created", { id: "sub_1" }, "evt_1"), env);
    expect((await allowance(env, user())).plan).toBe("free");
    sub = subscription({ status: "past_due", latest_invoice: { id: "in_2", status: "open", billing_reason: "subscription_cycle" } });
    await webhook(await event("customer.subscription.updated", { id: "sub_1" }, "evt_2", now() + 1), env);
    expect(sqlite.prepare("SELECT status FROM subscriptions").get()!.status).toBe("past_due");
  });
  it("cancels a subscription started by an account that was deleted", async () => {
    sqlite.exec("DELETE FROM users");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
      requests.push((init?.method || "GET") + " " + String(input));
      return Response.json(subscription({ status: init?.method === "DELETE" ? "canceled" : "active" }));
    }));
    await webhook(await event("checkout.session.completed", { subscription: "sub_1" }, "evt_1"), env);
    expect(requests.some((r) => r.startsWith("DELETE") && r.includes("/subscriptions/sub_1"))).toBe(true);
  });
  it("leaves subscriptions this app did not create alone", async () => {
    sqlite.exec("DELETE FROM users");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
      requests.push((init?.method || "GET") + " " + String(input));
      return Response.json(subscription({ metadata: {} }));
    }));
    await webhook(await event("customer.subscription.updated", { id: "sub_1" }, "evt_1"), env);
    expect(requests.every((r) => r.startsWith("GET"))).toBe(true);
  });
});

describe("account deletion", () => {
  it("closes open checkouts and does not grant a fresh trial on re-registration", async () => {
    sqlite.exec("INSERT INTO usage_windows(id,user_id,quota,used) VALUES('u:trial','u',1000,700)");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
      const url = String(input);
      requests.push((init?.method || "GET") + " " + url);
      if (url.includes("/subscriptions")) return Response.json({ object: "list", data: [], has_more: false });
      if (url.includes("/expire")) return Response.json({ id: "cs_open", status: "expired" });
      return Response.json({ object: "list", data: [{ id: "cs_open" }], has_more: false });
    }));
    const r = await call("/settings/account", "DELETE", { password }, { Cookie: "rech_session=session" });
    expect(r.status).toBe(200);
    expect(requests.some((x) => x.includes("/checkout/sessions/cs_open/expire"))).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM users").get()!.n).toBe(0);
    sqlite.prepare("INSERT INTO users VALUES('u2','U@test.invalid','Нов','hash',1,NULL,2)").run();
    const again = await allowance(env, sqlite.prepare("SELECT * FROM users WHERE id='u2'").get() as any);
    expect(again).toMatchObject({ plan: "free", used: 700, limit: 1000 });
  });
});

describe("request validation", () => {
  it("answers malformed and null JSON with 400 instead of an outage", async () => {
    expect((await call("/contact", "POST", "{not json")).status).toBe(400);
    expect((await call("/contact", "POST", "null")).status).toBe(400);
    expect((await call("/auth/login", "POST", "{")).status).toBe(400);
  });
  it("rejects prototype property names as voices", async () => {
    const project = { title: "Т", mode: "tts", script: "Текст", voice: "constructor", second_voice: "boris" };
    const auth = { Cookie: "rech_session=session" };
    expect((await call("/projects", "POST", project, auth)).status).toBe(400);
    expect((await call("/projects", "POST", { ...project, voice: "mila", second_voice: "toString" }, auth)).status).toBe(400);
    expect((await call("/projects", "POST", { ...project, voice: "mila" }, auth)).status).toBe(200);
  });
});

describe("storage reservation", () => {
  it("sizes audio reservations by length and keeps the old ceiling", async () => {
    const { audioReserveBytes, MB } = await import("../shared/media");
    expect(audioReserveBytes(1000, 1, 400)).toBeLessThan(15 * MB);
    // A 48 kHz recording spoken at 10 characters per second still fits.
    expect(audioReserveBytes(1000, 1, 400)).toBeGreaterThan((1000 / 10) * 96000 + 44);
    expect(audioReserveBytes(10000, 40, 1500)).toBe(96 * MB);
  });
});

describe("hourly maintenance", () => {
  it("keeps running later stages when an earlier one fails", async () => {
    env.MEDIA_ENABLED = "true";
    env.AUDIO = { list: async () => ({ objects: [], truncated: false }), head: async () => null, delete: async () => {} };
    sqlite.exec("DROP TABLE media_job_history");
    sqlite.prepare("INSERT INTO sessions VALUES('expired','u',1)").run();
    await maintenance(env);
    expect(console.error).toHaveBeenCalledWith("Maintenance stage failed", expect.objectContaining({ stage: "media" }));
    expect(sqlite.prepare("SELECT COUNT(*) n FROM sessions WHERE token_hash='expired'").get()!.n).toBe(0);
  });
  it("sweeps each finished job's segments once and moves on to older jobs", async () => {
    const listed: string[] = [];
    env.AUDIO = { list: async ({ prefix }: any) => { listed.push(prefix); return { objects: [], truncated: false }; }, delete: async () => {} };
    sqlite.exec("INSERT INTO projects VALUES('p','u','Т','tts','Т','mila','boris',400,1,1); INSERT INTO usage_windows(id,user_id,quota,used) VALUES('w','u',100000,0)");
    const insert = sqlite.prepare("INSERT INTO jobs(id,user_id,project_id,window_id,idempotency_key,title,mode,script,voice,second_voice,pause_ms,chars,status,created_at,updated_at) VALUES(?,'u','p','w',?,'Т','tts','Т','mila','boris',0,1,'completed',1,?)");
    for (let i = 0; i < 150; i++) insert.run("j" + i, "k" + i, 1000 + i);
    await maintenance(env);
    await maintenance(env);
    const swept = listed.filter((p) => p.startsWith("segments/"));
    expect(swept).toHaveLength(150);
    expect(new Set(swept).size).toBe(150);
    await maintenance(env);
    expect(listed.filter((p) => p.startsWith("segments/"))).toHaveLength(150);
  });
});
