import type { Env } from "./types";

// Approved by the owner. Operator details come from notebook; contact email uses rechbg.com.
// These are code defaults, not Wrangler vars: Dashboard overrides survive deploys.
export function withDefaults(env: Env): Env {
  return {
    ...env,
    SITE_URL: env.SITE_URL ?? "https://rechbg.com",
    COMPANY_NAME: env.COMPANY_NAME ?? "Радослав Додников (Кова студио)",
    COMPANY_CITY: env.COMPANY_CITY ?? "София",
    CONTACT_EMAIL: env.CONTACT_EMAIL ?? "info@rechbg.com",
    CONTACT_PHONE: env.CONTACT_PHONE ?? "+35924920201",
    EMAIL_FROM: env.EMAIL_FROM?.trim() || "info@rechbg.com",
    // No COMPANY_ID or full COMPANY_ADDRESS was present in notebook.
    // Email Sending for rechbg.com was enabled by the owner; admin access is separate.
  };
}
