import path from "path";

/** @type {import("next").NextConfig} */
const nextConfig = {
  // The e2e suite runs TWO dev servers side by side (the seeded one and the
  // clean-boot one — see playwright.config.ts). Both would compile into the same
  // `.next/` and race each other, so the clean-boot server is given its own
  // build dir. Unset everywhere else, which keeps the default `.next` exactly as
  // it was. Do NOT point this at a path outside the project — Next resolves it
  // relative to the project root.
  ...(process.env.ORCHESTRA_NEXT_DIST_DIR
    ? { distDir: process.env.ORCHESTRA_NEXT_DIST_DIR }
    : {}),
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
  serverExternalPackages: ["child_process", "pdfjs-dist"],
  outputFileTracingRoot: path.resolve(process.cwd()),
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
