import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));

const api = process.env.KINLILO_WEB_API_TARGET ?? process.env.KINLILO_API_URL ?? "http://127.0.0.1:4311";

export default {
  agentRules: false,
  devIndicators: false,
  transpilePackages: ["@kinlilo/contracts"],
  turbopack: { root },
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: api + "/api/auth/:path*" },
      { source: "/v1/:path*", destination: api + "/v1/:path*" },
    ];
  },
} satisfies NextConfig;
