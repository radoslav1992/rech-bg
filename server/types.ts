export interface Env {
  DB: D1Database;
  MEDIA_ENABLED?: string;
  MEDIA_GENERATION?: Workflow<{ taskId: string }>;
  MEDIA_RENDERER?: DurableObjectNamespace;
  AUDIO: R2Bucket;
  AI: {
    run: (model: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  GENERATION: Workflow<{ jobId: string }>;
  VIDEO_GENERATION?: Workflow<{ jobId: string }>;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICES?: string;
  STUDIO_SCRIPT_MODEL?: string;
  FAL_KEY?: string;
  WAVESPEED_API_KEY?: string;
  VIDEO_PROVIDER?: string;
  HEYGEN_API_KEY?: string;
  ASSETS: Fetcher;
  SITE_URL?: string;
  APP_ENV?: string;
  REGISTRATION_ENABLED?: string;
  BILLING_ENABLED?: string;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  CONTACT_EMAIL?: string;
  CONTACT_PHONE?: string;
  ADMIN_EMAILS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_CREATOR?: string;
  STRIPE_PRICE_STUDIO?: string;
  COMPANY_NAME?: string;
  COMPANY_ID?: string;
  COMPANY_ADDRESS?: string;
  COMPANY_CITY?: string;
}
export type DbUser = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  verified: number;
  created_at: number;
  stripe_customer: string | null;
};
export type ContextVars = { user: DbUser; session: string };
export const now = () => Math.floor(Date.now() / 1000);
export const uid = () => crypto.randomUUID();
export function ready(e: Env) {
  return !!(
    e.COMPANY_NAME &&
    e.COMPANY_ID &&
    e.COMPANY_ADDRESS &&
    e.CONTACT_EMAIL &&
    e.SITE_URL
  );
}
