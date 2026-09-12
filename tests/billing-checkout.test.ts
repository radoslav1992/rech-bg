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
function checkout() {
  return worker.fetch(new Request("https://rechbg.com/api/billing/checkout", {
    method: "POST", headers: { Origin: "https://rechbg.com", Cookie: "rech_session=session", "Content-Type": "application/json" }, body: JSON.stringify({ plan: "creator" }),
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
    if (url.includes("/prices/")) return Response.json({ active: true, currency: "eur", unit_amount: 1900, recurring: { interval: "month", interval_count: 1 }, tax_behavior: "inclusive" });
    return Response.json({ url: "https://checkout.stripe.com/test" });
  }));
  const response = await checkout();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "https://checkout.stripe.com/test" });
  expect(sqlite.prepare("SELECT COUNT(*) n FROM subscriptions").get()!.n).toBe(0);
  expect(log).not.toHaveBeenCalled();
});
