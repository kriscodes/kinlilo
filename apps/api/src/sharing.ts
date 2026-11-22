import { circleId, deviceId, registerDevice, startSharing, trackingSessionId } from "@kinlilo/contracts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { RequestError } from "./circles";
import { devices, latestLocations, lockAccount, memberships, trackingSessions, type Database } from "./db";

type Locals = { userId: string };

const deviceDetails = {
  id: devices.id,
  label: devices.label,
  registeredAt: devices.registeredAt,
  revokedAt: devices.revokedAt,
};

const sessionDetails = {
  id: trackingSessions.id,
  deviceId: trackingSessions.deviceId,
  startedAt: trackingSessions.startedAt,
};

function memberOf(id: string, userId: string) {
  return and(eq(memberships.circleId, id), eq(memberships.userId, userId));
}

function ownedDevice(id: string, userId: string) {
  return and(eq(devices.id, id), eq(devices.userId, userId));
}

async function readSharing(db: Pick<Database, "select">, id: string, userId: string) {
  const [sharing] = await db.select({ version: memberships.sharingVersion, activeSession: sessionDetails })
    .from(memberships)
    .leftJoin(trackingSessions, and(
      eq(trackingSessions.circleId, memberships.circleId),
      eq(trackingSessions.userId, memberships.userId),
      isNull(trackingSessions.endedAt),
    ))
    .where(memberOf(id, userId));
  if (!sharing) throw new RequestError(404, "Circle not found.");
  return sharing;
}

function requireId(schema: typeof circleId, value: unknown, message: string) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestError(404, message);
  return parsed.data;
}

const sessionEnd = sql`greatest(clock_timestamp(), ${trackingSessions.startedAt})`;

export function createSharingRouter(db: Database) {
  const router = Router();

  router.get<object, unknown, unknown, unknown, Locals>("/devices", async (_req, res) => {
    const list = await db.select(deviceDetails).from(devices).where(eq(devices.userId, res.locals.userId))
      .orderBy(asc(devices.registeredAt), asc(devices.id));
    res.json({ devices: list });
  });

  router.post<object, unknown, unknown, unknown, Locals>("/devices", async (req, res) => {
    const parsed = registerDevice.safeParse(req.body);
    if (!parsed.success) throw new RequestError(400, "Enter a valid installation ID and device label.");
    const userId = res.locals.userId;
    const result = await db.transaction(async tx => {
      if (!await lockAccount(tx, userId)) throw new RequestError(401, "Sign in to continue.");
      const { installationId, label } = parsed.data;
      const [existing] = await tx.select(deviceDetails).from(devices)
        .where(and(eq(devices.userId, userId), eq(devices.installationId, installationId)));
      if (existing?.revokedAt) throw new RequestError(409, "This installation was revoked.");
      if (existing) return { created: false, device: existing };
      const [device] = await tx.insert(devices).values({ id: randomUUID(), userId, installationId, label }).returning(deviceDetails);
      return { created: true, device };
    });
    res.status(result.created ? 201 : 200).json(result.device);
  });

  router.post<{ deviceId: string }, unknown, unknown, unknown, Locals>("/devices/:deviceId/revoke", async (req, res) => {
    const id = requireId(deviceId, req.params.deviceId, "Device not found.");
    const userId = res.locals.userId;
    const revoked = await db.transaction(async tx => {
      if (!await lockAccount(tx, userId)) throw new RequestError(401, "Sign in to continue.");
      const [device] = await tx.select(deviceDetails).from(devices).where(ownedDevice(id, userId));
      if (!device) throw new RequestError(404, "Device not found.");
      if (device.revokedAt) return device;

      const [updated] = await tx.update(devices).set({ revokedAt: sql`clock_timestamp()` })
        .where(ownedDevice(id, userId)).returning(deviceDetails);
      const activeSessions = and(eq(trackingSessions.deviceId, id), eq(trackingSessions.userId, userId), isNull(trackingSessions.endedAt));
      const affectedCircles = tx.select({ id: trackingSessions.circleId }).from(trackingSessions).where(activeSessions);
      await tx.update(memberships).set({ sharingVersion: sql`gen_random_uuid()` })
        .where(and(eq(memberships.userId, userId), inArray(memberships.circleId, affectedCircles)));
      await tx.delete(latestLocations)
        .where(and(eq(latestLocations.userId, userId), inArray(latestLocations.circleId, affectedCircles)));
      await tx.update(trackingSessions).set({ endedAt: sessionEnd }).where(activeSessions);
      return updated;
    });
    res.json(revoked);
  });

  router.get<{ circleId: string }, unknown, unknown, unknown, Locals>("/circles/:circleId/sharing", async (req, res) => {
    const id = requireId(circleId, req.params.circleId, "Circle not found.");
    res.json(await readSharing(db, id, res.locals.userId));
  });

  router.post<{ circleId: string }, unknown, unknown, unknown, Locals>("/circles/:circleId/tracking-sessions", async (req, res) => {
    const id = requireId(circleId, req.params.circleId, "Circle not found.");
    const parsed = startSharing.safeParse(req.body);
    if (!parsed.success) throw new RequestError(400, "A valid device ID and sharing version are required.");
    const { deviceId: requestedDeviceId, version: expectedVersion } = parsed.data;
    const userId = res.locals.userId;
    const state = await db.transaction(async tx => {
      if (!await lockAccount(tx, userId)) throw new RequestError(401, "Sign in to continue.");
      const current = await readSharing(tx, id, userId);
      if (current.version !== expectedVersion) throw new RequestError(409, "Sharing changed. Refresh before starting again.");

      const [device] = await tx.select({ revokedAt: devices.revokedAt }).from(devices).where(ownedDevice(requestedDeviceId, userId));
      if (!device) throw new RequestError(404, "Device not found.");
      if (device.revokedAt) throw new RequestError(409, "This device was revoked.");

      if (current.activeSession) {
        await tx.update(trackingSessions).set({ endedAt: sessionEnd }).where(eq(trackingSessions.id, current.activeSession.id));
        await tx.delete(latestLocations).where(and(eq(latestLocations.circleId, id), eq(latestLocations.userId, userId)));
      }
      const [activeSession] = await tx.insert(trackingSessions).values({
        id: randomUUID(), circleId: id, userId, deviceId: requestedDeviceId, startedAt: sql`clock_timestamp()`,
      }).returning(sessionDetails);
      const version = randomUUID();
      await tx.update(memberships).set({ sharingVersion: version }).where(memberOf(id, userId));
      return { version, activeSession };
    });
    res.status(201).json(state);
  });

  const pausePath = "/circles/:circleId/tracking-sessions/:sessionId/pause";
  router.post<{ circleId: string; sessionId: string }, unknown, unknown, unknown, Locals>(pausePath, async (req, res) => {
    const id = requireId(circleId, req.params.circleId, "Circle not found.");
    const sessionId = requireId(trackingSessionId, req.params.sessionId, "Tracking session not found.");
    const userId = res.locals.userId;
    const state = await db.transaction(async tx => {
      if (!await lockAccount(tx, userId)) throw new RequestError(401, "Sign in to continue.");
      const current = await readSharing(tx, id, userId);
      const session = and(eq(trackingSessions.id, sessionId), eq(trackingSessions.circleId, id), eq(trackingSessions.userId, userId));
      const [target] = await tx.select({ endedAt: trackingSessions.endedAt }).from(trackingSessions).where(session);
      if (!target) throw new RequestError(404, "Tracking session not found.");
      if (target.endedAt) return current;

      await tx.update(trackingSessions).set({ endedAt: sessionEnd }).where(session);
      await tx.delete(latestLocations).where(and(eq(latestLocations.circleId, id), eq(latestLocations.userId, userId)));
      const version = randomUUID();
      await tx.update(memberships).set({ sharingVersion: version }).where(memberOf(id, userId));
      return { version, activeSession: null };
    });
    res.json(state);
  });

  return router;
}
