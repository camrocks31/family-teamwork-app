import { AuthGate } from "@/components/auth-gate";
import { Dashboard } from "@/components/dashboard";

/**
 * Rendered to static HTML at build time. It holds no household data and makes
 * no authorization decision — there is no server to make one on. Everything
 * below the gate loads in the browser from Supabase, under RLS.
 */
export default function Home() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}
