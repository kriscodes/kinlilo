import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { createAuth } from "./auth";
import { createCirclesRouter, RequestError } from "./circles";
import type { Config } from "./config";
import { connectDatabase } from "./db";
import { createLocationsRouter } from "./locations";
import { createSharingRouter } from "./sharing";

export function createApp(config: Config) {
  const { pool, db } = connectDatabase(config.databaseUrl);
  const auth = createAuth(config, pool);
  const app = express();
  app.disable("x-powered-by");

  app.use(cors({
    origin: config.webOrigin,
    credentials: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "X-Kinlilo-Client"],
  }));

  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  app.use(["/api/auth", "/v1"], (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const handleAuth = toNodeHandler(auth);
  app.all("/api/auth/*splat", (req, res) => {
    // Ignore caller-supplied values. Use the actual peer observed by this server.
    req.headers["x-kinlilo-peer"] = req.socket.remoteAddress;
    return handleAuth(req, res);
  });

  app.use("/v1", (req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const origin = req.get("Origin");
    const trustedWeb = origin === config.webOrigin || origin === config.apiOrigin;
    const native = !origin && req.get("X-Kinlilo-Client") === "mobile";
    if (!trustedWeb && !native) return next(new RequestError(403, "Request origin is not allowed."));
    if (!req.is("application/json")) return next(new RequestError(415, "JSON is required."));
    next();
  });

  app.post("/v1/location-batches", express.json({ limit: "32kb" }));
  app.use("/v1", express.json({ limit: "8kb" }));
  app.use("/v1", async (req, res, next) => {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) throw new RequestError(401, "Sign in to continue.");
    res.locals.userId = session.user.id;
    next();
  });
  app.use("/v1", rateLimit({
    windowMs: 60_000,
    limit: 120,
    keyGenerator: (_req, res) => res.locals.userId,
    handler: (_req, _res, next) => next(new RequestError(429, "Too many requests. Try again in a minute.")),
  }));
  app.use("/v1/circles", createCirclesRouter(db));
  app.use("/v1", createSharingRouter(db));
  app.use("/v1/location-batches", createLocationsRouter(db));
  app.use((_req, _res, next) => next(new RequestError(404, "Page not found.")));

  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof RequestError) {
      res.status(error.status).json({ error: { message: error.message } });
      return;
    }
    if (error.type === "entity.parse.failed" || error.type === "entity.too.large") {
      res.status(error.status).json({ error: { message: "Invalid request body." } });
      return;
    }
    // Database errors can contain bound values, including invite codes or coordinates.
    console.error("Kinlilo API request failed.", error?.code ?? error?.name ?? "unknown");
    res.status(500).json({ error: { message: "Something went wrong. Try again." } });
  };
  app.use(handleError);
  return { app, pool };
}
