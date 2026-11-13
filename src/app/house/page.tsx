import { Suspense } from "react";
import { AuthGate } from "@/components/auth-gate";
import { RoomView } from "@/components/room-view";

/**
 * One room, reached as /house?space=<id>.
 *
 * A query string rather than a path segment because this is a static export:
 * a dynamic segment would need generateStaticParams, and room ids are
 * household data that does not exist at build time (HAL-1538 §2.4).
 *
 * useSearchParams suspends during prerender, so the boundary is required.
 */
export default function HousePage() {
  return (
    <AuthGate>
      <Suspense
        fallback={
          <output aria-live="polite" className="block p-6 text-muted">
            Loading…
          </output>
        }
      >
        <RoomView />
      </Suspense>
    </AuthGate>
  );
}
