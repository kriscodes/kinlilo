import { z } from "zod";

const env = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  BETTER_AUTH_SECRET: z.string().min(32),
  KINLILO_API_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:4311"),
  KINLILO_WEB_URL: z.url({ protocol: /^https?$/ }).default("http://127.0.0.1:4310"),
  KINLILO_API_HOST: z.string().default("127.0.0.1"),
});

export function readConfig() {
  const result = env.safeParse(process.env);
  if (!result.success) {
    throw new Error("Check Kinlilo environment settings: " + result.error.issues.map(issue => issue.path.join(".")).join(", "));
  }
  const values = result.data;
  return {
    databaseUrl: values.DATABASE_URL,
    secret: values.BETTER_AUTH_SECRET,
    apiOrigin: new URL(values.KINLILO_API_URL).origin,
    webOrigin: new URL(values.KINLILO_WEB_URL).origin,
    host: values.KINLILO_API_HOST,
    port: Number(process.env.KINLILO_API_PORT ?? (new URL(values.KINLILO_API_URL).port || 4311)),
    production: process.env.NODE_ENV === "production",
  };
}

export type Config = ReturnType<typeof readConfig>;
