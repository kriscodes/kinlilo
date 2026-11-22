import { circleId, historyQuery, type LocationHistory } from "@kinlilo/contracts";
import { and, asc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { RequestError } from "./circles";
import { devices, locationPoints, memberships, trackingSessions, type Database } from "./db";

type Locals = { userId: string };
const pageSize = 100;
const requestQuery = historyQuery.safeExtend({
  // React Native's fetch appends a cache-busting timestamp for no-store requests.
  _: z
    .string()
    .regex(/^\d{1,16}$/)
    .optional(),
});

export function locationRetentionCutoff(days: number) {
  return sql`statement_timestamp() - ${days} * interval '24 hours'`;
}

export function createLocationHistoryRouter(db: Database, retentionDays: number) {
  const router = Router();
  const viewer = alias(memberships, "viewer");

  router.get<{ id: string; memberId: string }, LocationHistory, unknown, unknown, Locals>(
    "/circles/:id/members/:memberId/history",
    async (req, res) => {
      const circle = circleId.safeParse(req.params.id);
      if (!circle.success) throw new RequestError(404, "Circle not found.");
      const query = requestQuery.safeParse(req.query);
      if (!query.success) throw new RequestError(400, "Choose a valid history range of up to 25 hours.");
      const { from, to, cursor } = query.data;
      const userId = res.locals.userId;
      const allowed = or(eq(memberships.userId, viewer.userId), isNotNull(devices.id));
      const afterCursor = cursor
        ? sql`(${locationPoints.capturedAt}, ${locationPoints.id}) > (${cursor.capturedAt}::timestamptz, ${cursor.id}::uuid)`
        : undefined;

      // The membership, consent, and location reads share a snapshot, including on later pages.
      const page = db
        .select({
          id: locationPoints.id,
          sessionId: locationPoints.sessionId,
          capturedAt: locationPoints.capturedAt,
          latitude: locationPoints.latitude,
          longitude: locationPoints.longitude,
          accuracyM: locationPoints.accuracyM,
        })
        .from(locationPoints)
        .where(
          and(
            eq(locationPoints.circleId, memberships.circleId),
            eq(locationPoints.userId, memberships.userId),
            allowed,
            gte(
              locationPoints.capturedAt,
              sql`greatest(${from}::timestamptz, ${viewer.joinedAt}, ${locationRetentionCutoff(retentionDays)})`,
            ),
            lt(locationPoints.capturedAt, sql`least(${to}::timestamptz, statement_timestamp())`),
            afterCursor,
          ),
        )
        .orderBy(asc(locationPoints.capturedAt), asc(locationPoints.id))
        .limit(pageSize + 1)
        .as("history_page");

      const rows = await db
        .select({
          allowed: sql<boolean>`${allowed}`,
          point: {
            id: page.id,
            sessionId: page.sessionId,
            capturedAt: page.capturedAt,
            latitude: page.latitude,
            longitude: page.longitude,
            accuracyM: page.accuracyM,
          },
        })
        .from(memberships)
        .innerJoin(viewer, and(eq(viewer.circleId, memberships.circleId), eq(viewer.userId, userId)))
        .leftJoin(
          trackingSessions,
          and(
            eq(trackingSessions.circleId, memberships.circleId),
            eq(trackingSessions.userId, memberships.userId),
            isNull(trackingSessions.endedAt),
          ),
        )
        .leftJoin(
          devices,
          and(
            eq(devices.id, trackingSessions.deviceId),
            eq(devices.userId, trackingSessions.userId),
            isNull(devices.revokedAt),
          ),
        )
        .leftJoinLateral(page, sql`true`)
        .where(and(eq(memberships.circleId, circle.data), eq(memberships.userId, req.params.memberId)))
        .orderBy(asc(page.capturedAt), asc(page.id));
      if (!rows.length) throw new RequestError(404, "Circle member not found.");

      const points = rows.slice(0, pageSize).flatMap(({ point }) => {
        if (!point) return [];
        const { sessionId, capturedAt, ...fix } = point;
        const segment = createHash("sha256").update(sessionId).digest("base64url").slice(0, 22);
        return [{ ...fix, capturedAt: capturedAt.toISOString(), segment }];
      });
      const next = rows.length > pageSize ? points.at(-1) : undefined;
      res.set("Cache-Control", "private, no-store").json({
        status: rows[0].allowed ? "available" : "sharing_off",
        points,
        nextCursor: next ? `${next.capturedAt}/${next.id}` : null,
      });
    },
  );

  return router;
}
