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

/**
 * An absolute URL for a page of this app, for Supabase to redirect back to.
 *
 * The deployed site lives under a base path (a GitHub Pages project site is
 * served from /<repo>/), and a recovery email is opened on whatever device
 * happens to be to hand — so the link has to carry the real origin and the
 * real prefix, not a relative path. Supabase also refuses to redirect anywhere
 * that is not on the project's allowlist, which makes a wrong value here fail
 * loudly rather than quietly.
 */
export function appUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}${base}${path}`;
}
