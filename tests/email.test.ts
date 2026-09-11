import { describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { withDefaults } from "../server/config";
import { sendMail, sha } from "../server/security";
import type { Env } from "../server/types";
import { database } from "./helpers";

function setup() {
  const { db, sqlite } = database();
  const send = vi.fn().mockResolvedValue({ messageId: "test-message" });
  const env = {
    DB: db,
    EMAIL: { send },
    APP_ENV: "development",
    REGISTRATION_ENABLED: "true",
    COMPANY_ID: "test-company",
    COMPANY_ADDRESS: "Test address",
  } as unknown as Env;
  const post = (path: string, body: unknown) => worker.fetch(new Request(
    `https://rechbg.com/api/auth/${path}`,
    { method: "POST", headers: { Origin: "https://rechbg.com", "Content-Type": "application/json" }, body: JSON.stringify(body) },
  ), env, {} as ExecutionContext);
  const registration = { name: "Тестов потребител", email: "user@example.com", password: "test-password-123", acceptTerms: true };
  return { sqlite, send, env, post, registration };
}

describe("Cloudflare authentication emails", () => {
  it("registers, verifies and resets a password using the EMAIL binding", async () => {
    const { sqlite, send, post, registration } = setup();
    try {
      const response = await post("register", registration);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, emailSent: true });
      const verification = send.mock.calls[0][0];
      expect(verification.from).toEqual({ email: "info@rechbg.com", name: "Реч БГ" });
      expect(verification.to).toBe(registration.email);
      const verifyToken = verification.text.match(/\/verify\?token=([a-f0-9]{64})/)[1];
      expect(sqlite.prepare("SELECT token_hash FROM auth_tokens WHERE kind='verify'").get()?.token_hash).toBe(await sha(verifyToken));
      expect((await post("verify", { token: verifyToken })).status).toBe(200);
      expect(sqlite.prepare("SELECT verified FROM users").get()?.verified).toBe(1);
      expect((await post("forgot", { email: registration.email })).status).toBe(200);
      const resetToken = send.mock.calls[1][0].text.match(/\/reset\?token=([a-f0-9]{64})/)[1];
      expect((await post("reset", { token: resetToken, password: "new-password-123" })).status).toBe(200);
      expect((await post("login", { email: registration.email, password: "new-password-123" })).status).toBe(200);
    } finally { sqlite.close(); }
  });

  it("blocks registration without a binding and reports a send failure truthfully", async () => {
    const { sqlite, env, send, post, registration } = setup();
    try {
      env.EMAIL = undefined;
      expect((await post("register", registration)).status).toBe(503);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()?.n).toBe(0);
      env.EMAIL = { send };
      send.mockRejectedValue(new Error("Sender unavailable"));
      const response = await post("register", registration);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, emailSent: false });
    } finally { sqlite.close(); }
  });

  it("accepts an existing display-name sender variable", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "test-message" });
    const env = withDefaults({ EMAIL: { send }, EMAIL_FROM: "Реч БГ <info@rechbg.com>" } as unknown as Env);
    await sendMail(env, "user@example.com", "Потвърдете имейла си", "Тест");
    expect(send.mock.calls[0][0].from).toEqual({ email: "info@rechbg.com", name: "Реч БГ" });
  });
});
