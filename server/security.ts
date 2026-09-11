import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { Env, ContextVars } from "./types";
import { now } from "./types";
export const sha = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const hex = (a: Uint8Array) =>
  Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
export const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function hashPassword(
  password: string,
  salt = hex(crypto.getRandomValues(new Uint8Array(16))),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return `pbkdf2:100000:${salt}:${hex(new Uint8Array(bits))}`;
}
export async function checkPassword(password: string, stored: string) {
  const parts = stored.split(":");
  if (parts.length !== 4) return false;
  const actual = await hashPassword(password, parts[2]);
  return safeEqual(actual, stored);
}
export function safeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export async function rate(
  c: Context<{ Bindings: Env; Variables: ContextVars }>,
  scope: string,
  max = 20,
  seconds = 3600,
  identity?: string,
) {
  const ip = identity || c.req.header("CF-Connecting-IP") || "local";
  const bucket = Math.floor(now() / seconds);
  const key = await sha(scope + ":" + ip + ":" + bucket);
  const r = await c.env.DB.prepare(
    "INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits",
  )
    .bind(key, (bucket + 1) * seconds)
    .first<{ hits: number }>();
  if (r && r.hits > max)
    throw new HTTPException(429, {
      message: "Твърде много опити. Опитайте отново по-късно.",
    });
}
export async function sendMail(
  env: Env,
  to: string,
  subject: string,
  text: string,
) {
  if (!env.EMAIL || !env.EMAIL_FROM)
    throw new HTTPException(503, {
      message: "Изпращането на имейли временно не е достъпно.",
    });
  // Accept the previous display-name format in existing Dashboard variables.
  const sender = env.EMAIL_FROM.trim();
  const named = sender.match(/^([^<>]*)<([^<>]+)>$/);
  try {
    await env.EMAIL.send({
      from: {
        email: named ? named[2].trim() : sender,
        name: named?.[1].trim() || "Реч БГ",
      },
      to,
      subject,
      text,
    });
  } catch (cause) {
    throw new HTTPException(503, {
      message: "Писмото не беше изпратено. Опитайте отново след малко.",
      cause,
    });
  }
}
export function origin(env: Env, request: Request) {
  return env.SITE_URL?.replace(/\/$/, "") || new URL(request.url).origin;
}
