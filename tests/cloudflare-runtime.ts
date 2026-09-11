// Tests use local bindings; production imports the real Cloudflare runtime.
export class WorkflowEntrypoint {
  env: any;
  constructor(_ctx: any, env: any) {
    this.env = env;
  }
}
