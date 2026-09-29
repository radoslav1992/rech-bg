import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../server/index";
import { database } from "./helpers";
import { sha } from "../server/security";
import { now } from "../server/types";

let env: any, sqlite: ReturnType<typeof database>["sqlite"];
let log: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  sqlite.exec("INSERT INTO users VALUES('u','private@example.com','User','hash',1,'cus_1',1)");
  sqlite.prepare("INSERT INTO sessions VALUES(?,'u',?)").run(await sha("session"), now() + 3600);
  env = { DB: d.db, BILLING_ENABLED: "true", COMPANY_ID: "123", COMPANY_ADDRESS: "Sofia address", STRIPE_SECRET_KEY: "sk_test_private", STRIPE_PRICE_CREATOR: "price_creator" };
  log = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sqlite.close(); });
function checkout(plan = "creator") {
  return worker.fetch(new Request("https://rechbg.com/api/billing/checkout", {
    method: "POST", headers: { Origin: "https://rechbg.com", Cookie: "rech_session=session", "Content-Type": "application/json" }, body: JSON.stringify({ plan }),
  }), env, { waitUntil: () => {} } as any);
}
it.each([
  [401, "authentication_error", undefined, undefined, "Invalid key", "BILLING_STRIPE_KEY"],
  [404, "invalid_request_error", "resource_missing", "customer", "No such customer", "BILLING_CUSTOMER_ACCOUNT"],
  [404, "invalid_request_error", "resource_missing", "price", "No such price", "BILLING_PRICE_ACCOUNT"],
  [400, "invalid_request_error", undefined, "automatic_tax[enabled]", "Set head office address", "BILLING_TAX_SETUP"],
  [400, "invalid_request_error", undefined, "configuration", "Portal configuration missing", "BILLING_PORTAL_SETUP"],
])("reports a safe diagnostic for Stripe HTTP %s / %s / %s / %s", async (status, type, code, param, message, expected) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { type, code, param, message: message + " sk_test_private private@example.com" } }, { status: status as number, headers: { "request-id": "req_test123" } })));
  const response = await checkout();
  expect(response.status).toBe(503);
  const body = await response.json() as any;
  expect(body.code).toBe(expected);
  expect(body.error).toContain(body.reference);
  expect(log).toHaveBeenCalledWith("Billing request failed", expect.objectContaining({ code: expected, reference: body.reference, stripeRequestId: "req_test123" }));
  const output = JSON.stringify([body, log.mock.calls]);
  expect(output).not.toContain("sk_test_private");
  expect(output).not.toContain("private@example.com");
});
it("identifies missing checkout schema without exposing SQL", async () => {
  sqlite.exec("DROP TABLE checkout_intents");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [] })));
  const response = await checkout();
  expect((await response.json() as any).code).toBe("BILLING_DB_SCHEMA");
  expect(JSON.stringify(log.mock.calls)).not.toContain("checkout_intents");
});
it("preserves successful checkout and grants no credits before the webhook", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => {
    const url = String(input);
    if (url.includes("/subscriptions")) return Response.json({ data: [] });
    if (url.includes("/prices/")) return Response.json({ active: true, currency: "eur", unit_amount: 2900, recurring: { interval: "month", interval_count: 1 }, tax_behavior: "inclusive" });
    return Response.json({ url: "https://checkout.stripe.com/test" });
  }));
  const response = await checkout();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/test" });
  expect(sqlite.prepare("SELECT COUNT(*) n FROM subscriptions").get()!.n).toBe(0);
  expect(log).not.toHaveBeenCalled();
});

it.each([
  ["starter", "STRIPE_PRICE_STARTER", 1200, 900],
  ["creator", "STRIPE_PRICE_CREATOR", 2900, 1900],
  ["studio", "STRIPE_PRICE_STUDIO", 5900, 3900],
])("checks the new %s price and rejects the old amount", async (plan, variable, amount, oldAmount) => {
  env[variable] = "price_new_" + plan;
  let unitAmount = oldAmount;
  const sessions: URLSearchParams[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
    const url = String(input);
    if (url.includes("/subscriptions")) return Response.json({ data: [] });
    if (url.includes("/prices/")) return Response.json({ active: true, currency: "eur", unit_amount: unitAmount, recurring: { interval: "month", interval_count: 1 }, tax_behavior: "inclusive" });
    sessions.push(new URLSearchParams(init.body));
    return Response.json({ url: "https://checkout.stripe.com/new" });
  }));
  expect((await checkout(String(plan))).status).toBe(503);
  expect(sessions).toHaveLength(0);
  unitAmount = amount;
  expect((await checkout(String(plan))).status).toBe(200);
  expect(sessions[0].get("line_items[0][price]")).toBe("price_new_" + plan);
  expect(sessions[0].get("automatic_tax[enabled]")).toBe("true");
});
it("uses a fresh Stripe idempotency key when the configured price changes", async () => {
  const keys: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any) => {
    const url = String(input);
    if (url.includes("/subscriptions")) return Response.json({ data: [] });
    if (url.includes("/prices/")) return Response.json({ active: true, currency: "eur", unit_amount: 2900, recurring: { interval: "month", interval_count: 1 }, tax_behavior: "inclusive" });
    keys.push(new Headers(init.headers).get("idempotency-key")!);
    return Response.json({ url: "https://checkout.stripe.com/new" });
  }));
  expect((await checkout()).status).toBe(200);
  expect((await checkout()).status).toBe(200);
  env.STRIPE_PRICE_CREATOR = "price_replacement";
  expect((await checkout()).status).toBe(200);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[2]).not.toBe(keys[0]);
  expect(keys[2]).toContain("price_replacement");
});

it("re-reads the customer's subscriptions from Stripe on return from the portal", async () => {
  env.STRIPE_PRICE_STUDIO = "price_studio";
  const sub = { id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: false,
    items: { data: [{ id: "si_1", price: { id: "price_studio" }, current_period_start: 100, current_period_end: now() + 100000 }] },
    latest_invoice: { id: "in_1", status: "paid" } };
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ object: "list", data: [sub], has_more: false }));
  vi.stubGlobal("fetch", fetchMock);
  const r = await worker.fetch(new Request("https://rechbg.com/api/billing/sync", {
    method: "POST", headers: { Origin: "https://rechbg.com", Cookie: "rech_session=session", "Content-Type": "application/json" }, body: "{}",
  }), env, { waitUntil: () => {} } as any);
  expect(r.status).toBe(200);
  expect(String(fetchMock.mock.calls[0][0])).toContain("customer=cus_1");
  expect(sqlite.prepare("SELECT plan,status FROM subscriptions WHERE id='sub_1'").get()).toEqual({ plan: "studio", status: "active" });
  const me = await (await worker.fetch(new Request("https://rechbg.com/api/auth/me", { headers: { Cookie: "rech_session=session" } }), env, { waitUntil: () => {} } as any)).json() as any;
  expect(me.user).toMatchObject({ plan: "studio", limit: 250000 });
});
function portal(body: unknown) {
  return worker.fetch(new Request("https://rechbg.com/api/billing/portal", {
    method: "POST", headers: { Origin: "https://rechbg.com", Cookie: "rech_session=session", "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil: () => {} } as any);
}
it("opens the plan change confirmation and returns to the app by itself", async () => {
  env.STRIPE_PRICE_STARTER = "price_starter";
  const sub = { id: "sub_1", object: "subscription", status: "active", items: { data: [{ id: "si_1", price: { id: "price_starter" } }] } };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/subscriptions")) return Response.json({ object: "list", data: [sub], has_more: false });
    if (url.includes("/v1/billing_portal/sessions")) return Response.json({ id: "bps_1", url: "https://billing.stripe.com/p/session/1", body: String(init?.body) });
    throw new Error("Unexpected " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  const r = await portal({ plan: "creator" });
  expect((await r.json() as any).url).toBe("https://billing.stripe.com/p/session/1");
  const body = decodeURIComponent(String(fetchMock.mock.calls.find(c => String(c[0]).includes("billing_portal"))![1]!.body));
  expect(body).toContain("flow_data[type]=subscription_update_confirm");
  expect(body).toContain("flow_data[subscription_update_confirm][items][0][price]=price_creator");
  expect(body).toContain("flow_data[after_completion][redirect][return_url]=https://rechbg.com/app/billing?portal=1");
});
it("falls back to the plain portal when the plan change flow is not possible", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/v1/subscriptions")) return Response.json({ object: "list", data: [], has_more: false });
    if (url.includes("/v1/billing_portal/sessions")) return Response.json({ id: "bps_2", url: "https://billing.stripe.com/p/session/2", body: String(init?.body) });
    throw new Error("Unexpected " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  const r = await portal({ plan: "creator" });
  expect((await r.json() as any).url).toBe("https://billing.stripe.com/p/session/2");
  const body = decodeURIComponent(String(fetchMock.mock.calls.at(-1)![1]!.body));
  expect(body).not.toContain("flow_data");
});
