import { circleId, getFixStatus, locationBatch, type CircleLocations, type LocationBatchEventResult, type LocationBatchResult } from "@kinlilo/contracts";
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { RequestError } from "./circles";
import { authUsers, devices, latestLocations, locationPoints, lockAccount, memberships, trackingSessions, type Database } from "./db";

type Locals = { userId: string };
type NewPoint = typeof locationPoints.$inferInsert;
const maximumClockSkewMs = 2 * 60 * 1_000;

export function createLocationsRouter(db: Database) {
  const router = Router();

  router.get<{ id: string }, CircleLocations, unknown, unknown, Locals>("/circles/:id/locations", async (req, res) => {
    const id = circleId.safeParse(req.params.id);
    if (!id.success) throw new RequestError(404, "Circle not found.");
    const viewer = alias(memberships, "viewer");
    const prior = alias(trackingSessions, "prior_session");
    const hasShared = db.select({ id: prior.id }).from(prior)
      .where(and(eq(prior.circleId, memberships.circleId), eq(prior.userId, memberships.userId)));

    // Authorize the viewer and filter every position in the same database snapshot.
    const members = await db.select({
      id: authUsers.id, name: authUsers.name, role: memberships.role,
      activeDeviceId: devices.id,
      hasShared: sql<boolean>`exists (${hasShared})`,
      now: sql<Date>`statement_timestamp()`.mapWith(locationPoints.capturedAt),
      fix: {
        latitude: locationPoints.latitude, longitude: locationPoints.longitude,
        accuracyM: locationPoints.accuracyM, capturedAt: locationPoints.capturedAt,
      },
    }).from(memberships)
      .innerJoin(viewer, and(eq(viewer.circleId, memberships.circleId), eq(viewer.userId, res.locals.userId)))
      .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
      .leftJoin(trackingSessions, and(
        eq(trackingSessions.circleId, memberships.circleId), eq(trackingSessions.userId, memberships.userId), isNull(trackingSessions.endedAt),
      ))
      .leftJoin(devices, and(eq(devices.id, trackingSessions.deviceId), eq(devices.userId, trackingSessions.userId), isNull(devices.revokedAt)))
      .leftJoin(latestLocations, and(eq(latestLocations.circleId, memberships.circleId), eq(latestLocations.userId, memberships.userId)))
      .leftJoin(locationPoints, and(
        eq(locationPoints.id, latestLocations.pointId), eq(locationPoints.sessionId, trackingSessions.id),
        isNotNull(devices.id), gte(locationPoints.capturedAt, viewer.joinedAt),
      ))
      .where(eq(memberships.circleId, id.data)).orderBy(asc(authUsers.name), asc(authUsers.id));
    if (!members.length) throw new RequestError(404, "Circle not found.");

    res.set("Cache-Control", "private, no-store").json({
      members: members.map(({ id, name, role, activeDeviceId, hasShared, now, fix }) => {
        const member = { id, name, role };
        if (!fix) return { ...member, status: activeDeviceId ? "unavailable" : hasShared ? "paused" : "off", fix: null };
        return { ...member, status: getFixStatus(fix.capturedAt.getTime(), now.getTime()), fix: { ...fix, capturedAt: fix.capturedAt.toISOString() } };
      }),
    });
  });

  router.post<object, LocationBatchResult, unknown, unknown, Locals>("/location-batches", async (req, res) => {
    const parsed = locationBatch.safeParse(req.body);
    if (!parsed.success) throw new RequestError(400, "Enter a valid location batch with 1 to 100 samples.");
    const { sessionId, events } = parsed.data;
    const userId = res.locals.userId;
    const result = await db.transaction(async tx => {
      // Use the same account lock as pause, device revocation, session replacement, and leaving a circle.
      if (!await lockAccount(tx, userId)) throw new RequestError(401, "Sign in to continue.");
      const [session] = await tx.select({
        id: trackingSessions.id,
        circleId: trackingSessions.circleId,
        deviceId: trackingSessions.deviceId,
        startedAt: trackingSessions.startedAt,
        receivedAt: sql<Date>`clock_timestamp()`.mapWith(trackingSessions.startedAt),
      }).from(trackingSessions).innerJoin(devices, and(
        eq(trackingSessions.deviceId, devices.id), eq(trackingSessions.userId, devices.userId),
      )).where(and(
        eq(trackingSessions.id, sessionId), eq(trackingSessions.userId, userId),
        isNull(trackingSessions.endedAt), isNull(devices.revokedAt),
      ));
      if (!session) throw new RequestError(404, "Active tracking session not found.");

      const stored = await tx.select({
        eventId: locationPoints.eventId,
        sessionId: locationPoints.sessionId,
        capturedAt: locationPoints.capturedAt,
        latitude: locationPoints.latitude,
        longitude: locationPoints.longitude,
        accuracyM: locationPoints.accuracyM,
      }).from(locationPoints).where(and(
        eq(locationPoints.deviceId, session.deviceId),
        inArray(locationPoints.eventId, events.map(event => event.eventId)),
      ));
      const seen = new Map(stored.map(point => [point.eventId, point]));
      const points: NewPoint[] = [];
      const results: LocationBatchEventResult[] = [];
      const latestAllowed = session.receivedAt.getTime() + maximumClockSkewMs;
      let latest: NewPoint | undefined;

      for (const event of events) {
        const { eventId, latitude, longitude, accuracyM } = event;
        const key = eventId.toLowerCase();
        const capturedAt = new Date(event.capturedAt);
        const previous = seen.get(key);
        if (previous) {
          const matches = previous.sessionId === session.id
            && previous.capturedAt.getTime() === capturedAt.getTime()
            && previous.latitude === latitude && previous.longitude === longitude && previous.accuracyM === accuracyM;
          results.push(matches ? { eventId, status: "duplicate" } : { eventId, status: "rejected", reason: "event_conflict" });
          continue;
        }
        if (capturedAt < session.startedAt) {
          results.push({ eventId, status: "rejected", reason: "before_session" });
          continue;
        }
        if (capturedAt.getTime() > latestAllowed) {
          results.push({ eventId, status: "rejected", reason: "future_timestamp" });
          continue;
        }

        const point = {
          id: randomUUID(), sessionId: session.id, circleId: session.circleId, userId, deviceId: session.deviceId,
          eventId: key, capturedAt, receivedAt: session.receivedAt, latitude, longitude, accuracyM,
        };
        seen.set(key, point);
        points.push(point);
        results.push({ eventId, status: "accepted" });
        if (!latest || capturedAt > latest.capturedAt || (capturedAt.getTime() === latest.capturedAt.getTime() && point.id > latest.id)) {
          latest = point;
        }
      }

      if (latest) {
        await tx.insert(locationPoints).values(points);
        await tx.insert(latestLocations).values({
          circleId: session.circleId, userId, capturedAt: latest.capturedAt, pointId: latest.id,
        }).onConflictDoUpdate({
          target: [latestLocations.circleId, latestLocations.userId],
          set: { capturedAt: latest.capturedAt, pointId: latest.id },
          setWhere: sql`(excluded.captured_at, excluded.point_id) > (${latestLocations.capturedAt}, ${latestLocations.pointId})`,
        });
      }
      return { serverTime: session.receivedAt.toISOString(), results };
    });
    res.json(result);
  });

  return router;
}
