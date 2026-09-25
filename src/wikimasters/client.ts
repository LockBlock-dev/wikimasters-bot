// Session-holding client: one boot per command/daemon, fresh tokens on every
// use without threading `session` through every call. Thin by design — the
// api.ts / supabase.ts function surface stays as-is (and stays mockable);
// this only owns lifecycle.
import { ensureSession } from "./session.ts";
import { supabaseFor } from "./supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WikiSession } from "./types.ts";

export class WikiClient {
  private cached: WikiSession | null = null;

  private constructor() {}

  static async boot(): Promise<WikiClient> {
    const c = new WikiClient();
    await c.session();
    return c;
  }

  /** Fresh session (cheap when the token is valid, refreshes when near expiry). */
  async session(): Promise<WikiSession> {
    this.cached = await ensureSession();
    return this.cached;
  }

  /** Last-seen access token (null before the first session()). */
  get token(): string | null {
    return this.cached?.access_token ?? null;
  }

  /** Direct Supabase client bound to a fresh session. */
  async db(): Promise<SupabaseClient> {
    return supabaseFor(await this.session());
  }
}
