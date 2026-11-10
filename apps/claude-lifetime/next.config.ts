import type { NextConfig } from "next";

// The portfolio serves the app at /claude-lifetime. Set CLAUDE_LIFETIME_BASE_PATH to an
// empty value to build it for the root of a domain instead.
const basePath = process.env.CLAUDE_LIFETIME_BASE_PATH ?? "/claude-lifetime";

const nextConfig: NextConfig = {
  output: "export",
  basePath: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
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
