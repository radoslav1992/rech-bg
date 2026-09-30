import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../server/index";
import { database } from "./helpers";
import { now } from "../server/types";
import { sha } from "../server/security";

let env: any, sqlite: ReturnType<typeof database>["sqlite"];
beforeEach(async () => {
  const d = database(); sqlite = d.sqlite;
  sqlite.exec("INSERT INTO users VALUES('a','owner@example.com','Owner','hash',1,NULL,1)");
  sqlite.exec("INSERT INTO users VALUES('t','Tester@Example.com','Тестер','hash',1,NULL,1)");
  sqlite.prepare("INSERT INTO sessions VALUES(?,'a',?)").run(await sha("admin"), now() + 3600);
  sqlite.prepare("INSERT INTO sessions VALUES(?,'t',?)").run(await sha("tester"), now() + 3600);
  env = { DB: d.db, ADMIN_EMAILS: "owner@example.com" };
});
afterEach(() => { sqlite.close(); });
const call = (path: string, session: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  worker.fetch(new Request("https://rechbg.com/api" + path, {
    method, headers: { Origin: "https://rechbg.com", Cookie: `rech_session=${session}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil: () => {} } as any);
const me = async () => ((await (await call("/auth/me", "tester")).json()) as any).user;

describe("plan grants", () => {
  it("are for administrators only", async () => {
    expect((await call("/admin/grants", "tester", { email: "tester@example.com", plan: "studio" })).status).toBe(403);
    expect((await call("/admin/grants", "tester")).status).toBe(403);
  });
  it("give a plan with its credits for 30 days without Stripe, and end it", async () => {
    expect((await call("/admin/grants", "admin", { email: "nobody@example.com", plan: "studio" })).status).toBe(404);
    const res = await call("/admin/grants", "admin", { email: " TESTER@example.com ", plan: "studio" });
    expect(res.status).toBe(201);
    const { id, end, paidPlan } = await res.json() as any;
    expect(end - now()).toBeGreaterThan(29 * 86400);
    expect(paidPlan).toBeNull();
    expect(await me()).toMatchObject({ plan: "studio", limit: 250000, used: 0, granted: true, hasSubscription: false, periodEnd: end });
    const list = await (await call("/admin/grants", "admin")).json() as any;
    expect(list.grants).toMatchObject([{ id, plan: "studio", email: "Tester@Example.com" }]);
    const removed = await call(`/admin/grants/${id}`, "admin", undefined, "DELETE");
    expect(removed.status).toBe(200);
    expect(await me()).toMatchObject({ plan: "free", granted: false });
    expect((await call(`/admin/grants/${id}`, "admin", undefined, "DELETE")).status).toBe(404);
  });
  it("replaces a running grant with a new month and fresh credits", async () => {
    const first = await (await call("/admin/grants", "admin", { email: "tester@example.com", plan: "creator" })).json() as any;
    await me();
    sqlite.prepare("UPDATE usage_windows SET used=90000 WHERE user_id='t'").run();
    expect(await me()).toMatchObject({ plan: "creator", used: 90000 });
    const second = await (await call("/admin/grants", "admin", { email: "tester@example.com", plan: "studio" })).json() as any;
    expect(second.id).not.toBe(first.id);
    expect(await me()).toMatchObject({ plan: "studio", used: 0, limit: 250000 });
    expect((sqlite.prepare("SELECT period_end FROM subscriptions WHERE id=?").get(first.id) as any).period_end).toBeLessThanOrEqual(now());
  });
  it("win over a paid plan while they run, and the paid plan returns after", async () => {
    sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES('sub_1','t','starter','active',1,?,0,0)").run(now() + 20 * 86400);
    const r = await (await call("/admin/grants", "admin", { email: "tester@example.com", plan: "studio" })).json() as any;
    expect(r.paidPlan).toBe("starter");
    expect(await me()).toMatchObject({ plan: "studio", granted: true, hasSubscription: true });
    // Ended (e.g. after 30 days): the paid subscription applies again.
    sqlite.prepare("UPDATE subscriptions SET period_end=? WHERE id=?").run(now() - 1, r.id);
    expect(await me()).toMatchObject({ plan: "starter", granted: false, hasSubscription: true });
  });
});
