import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
export class MediaRenderer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "1m";
  envVars = {
    SOURCE_ORIGIN: new URL(this.env.SITE_URL || "https://rechbg.com").origin,
  };
}
