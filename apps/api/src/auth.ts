import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";
import type { Config } from "./config";

export function createAuth(config: Config, pool: Pool) {
  return betterAuth({
    appName: "Kinlilo",
    database: pool,
    baseURL: config.apiOrigin,
    secret: config.secret,
    trustedOrigins: [config.webOrigin, "kinlilo://", ...(!config.production ? ["exp://**"] : [])],
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    hooks: {
      before: createAuthMiddleware(async context => {
        if (context.path !== "/sign-up/email" && context.path !== "/update-user") return;
        if (context.body?.name === undefined && context.path === "/update-user") return;
        const name = typeof context.body?.name === "string" ? context.body.name.trim() : "";
        if (name.length < 1 || name.length > 80) {
          throw new APIError("BAD_REQUEST", { message: "Enter a name of 1 to 80 characters." });
        }
        return { context: { ...context, body: { ...context.body, name } } };
      }),
    },
    rateLimit: { enabled: true, window: 60, max: 100 },
    advanced: {
      cookiePrefix: "kinlilo",
      useSecureCookies: config.production,
      ipAddress: { ipAddressHeaders: ["x-kinlilo-peer"] },
    },
    plugins: [expo()],
  });
}
