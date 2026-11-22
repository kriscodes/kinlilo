import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { doublePrecision, foreignKey, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { Pool } from "pg";

export const authUsers = pgTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
});

export const circles = pgTable("circles", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = pgTable("circle_memberships", {
  circleId: uuid("circle_id").notNull().references(() => circles.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  role: text({ enum: ["owner", "member"] }).notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  sharingVersion: uuid("sharing_version").notNull().defaultRandom(),
}, table => [primaryKey({ columns: [table.circleId, table.userId] })]);

export const invites = pgTable("circle_invites", {
  tokenHash: text("token_hash").primaryKey(),
  circleId: uuid("circle_id").notNull().references(() => circles.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
});

export const devices = pgTable("devices", {
  id: uuid().primaryKey(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  installationId: uuid("installation_id").notNull(),
  label: text().notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const trackingSessions = pgTable("tracking_sessions", {
  id: uuid().primaryKey(),
  circleId: uuid("circle_id").notNull(),
  userId: text("user_id").notNull(),
  deviceId: uuid("device_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, table => [
  foreignKey({ columns: [table.circleId, table.userId], foreignColumns: [memberships.circleId, memberships.userId] }).onDelete("cascade"),
  foreignKey({ columns: [table.userId, table.deviceId], foreignColumns: [devices.userId, devices.id] }).onDelete("cascade"),
]);

export const locationPoints = pgTable("location_points", {
  id: uuid().primaryKey(),
  sessionId: uuid("session_id").notNull(),
  circleId: uuid("circle_id").notNull(),
  userId: text("user_id").notNull(),
  deviceId: uuid("device_id").notNull(),
  eventId: uuid("event_id").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  latitude: doublePrecision().notNull(),
  longitude: doublePrecision().notNull(),
  accuracyM: doublePrecision("accuracy_m").notNull(),
}, table => [foreignKey({
  columns: [table.sessionId, table.circleId, table.userId, table.deviceId],
  foreignColumns: [trackingSessions.id, trackingSessions.circleId, trackingSessions.userId, trackingSessions.deviceId],
}).onDelete("cascade")]);

export const latestLocations = pgTable("latest_locations", {
  circleId: uuid("circle_id").notNull(),
  userId: text("user_id").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  pointId: uuid("point_id").notNull(),
}, table => [
  primaryKey({ columns: [table.circleId, table.userId] }),
  foreignKey({
    columns: [table.circleId, table.userId, table.capturedAt, table.pointId],
    foreignColumns: [locationPoints.circleId, locationPoints.userId, locationPoints.capturedAt, locationPoints.id],
  }).onDelete("cascade"),
]);

export function connectDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  return { pool, db: drizzle(pool) };
}

export type Database = ReturnType<typeof connectDatabase>["db"];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function lockAccount(tx: Transaction, userId: string) {
  // Serialize changes to an account's sharing, devices, and membership without blocking foreign-key inserts.
  const [account] = await tx.select({ id: authUsers.id }).from(authUsers)
    .where(eq(authUsers.id, userId)).for("no key update");
  return account !== undefined;
}
