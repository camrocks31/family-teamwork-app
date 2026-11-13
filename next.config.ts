import type { NextConfig } from "next";

/**
 * Our Family Hub ships as a pure static export served from GitHub Pages.
 * There is no application server: every server-side guarantee lives in
 * Supabase (Postgres SECURITY DEFINER functions and Edge Functions).
 * See HAL-1538 §2.4.
 *
 * Consequences enforced here, and verified against the installed
 * Next.js 16.4.6 docs (node_modules/next/dist/docs/01-app/02-guides/static-exports.md):
 *
 *   - The build does NOT reject server code, despite the docs listing route
 *     handlers, cookies() and server actions as unsupported. Measured on
 *     2026-11-13 with this version: all three build cleanly under
 *     `output: "export"`. They would then deploy and silently not work, since
 *     GitHub Pages serves files and runs nothing. The guard is therefore
 *     `scripts/check-static-export.mjs`, a source scan run in CI — not the
 *     build. Do not reintroduce the assumption that the build catches this.
 *   - Dynamic route segments are unsupported without generateStaticParams,
 *     and our ids are runtime data, so no route uses one. A single space is
 *     reached as /house?space=<id> and resolved client-side.
 *   - Image Optimization with the default loader needs a server.
 *   - `cacheComponents`/`partialPrefetching` (Partial Prerendering) are
 *     deliberately NOT enabled: PPR streams from a server we do not have.
 */
const nextConfig: NextConfig = {
  output: "export",

  // GitHub Pages serves a project site under /<repo>/. Set
  // NEXT_PUBLIC_BASE_PATH at build time for the deployed site; local
  // development and tests run at the root.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH || undefined,

  // Emit /house/index.html rather than /house.html, which is what GitHub
  // Pages needs to serve a clean URL without a server-side rewrite.
  trailingSlash: true,

  images: { unoptimized: true },

  // Type errors always fail the build. (Next 16 removed the `eslint` config
  // key; linting runs as its own required check in package.json and CI.)
  typescript: { ignoreBuildErrors: false },

  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
