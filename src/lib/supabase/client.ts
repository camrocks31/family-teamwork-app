import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The browser Supabase client.
 *
 * This app is a static export served from a public URL, so this bundle is
 * untrusted code that anyone can read and anyone can modify before running
 * (HAL-1538 §2.4). Two consequences are deliberate:
 *
 *   1. Only the anon key ships here. It is public by design and useless on its
 *      own: every table has RLS, and the rows it can reach are exactly the rows
 *      policy allows. A service-role key must never appear in this bundle.
 *   2. Nothing in the client is an authorization decision. Every state change
 *      goes through a Postgres SECURITY DEFINER function or an Edge Function
 *      that re-checks the caller. Hiding a button is presentation, not
 *      security.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Configuration is absent rather than wrong when the app has never been set up.
 * Fail loudly at the call site instead of constructing a client that silently
 * talks to nothing (HAL-1538 §3.1, Absent).
 */
export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "Supabase is not configured. Copy .env.local.example to .env.local and " +
        "fill in NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
    this.name = "SupabaseNotConfiguredError";
  }
}

export function isSupabaseConfigured(): boolean {
  return Boolean(url && anonKey);
}

let cached: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!url || !anonKey) throw new SupabaseNotConfiguredError();
  cached ??= createClient(url, anonKey, {
    auth: {
      // A static export has no server to set cookies, so the session lives in
      // the browser and is refreshed there.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return cached;
}
