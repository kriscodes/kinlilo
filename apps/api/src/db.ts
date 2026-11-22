import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
}, table => [primaryKey({ columns: [table.circleId, table.userId] })]);

export const invites = pgTable("circle_invites", {
  tokenHash: text("token_hash").primaryKey(),
  circleId: uuid("circle_id").notNull().references(() => circles.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
});

export function connectDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10 });
  return { pool, db: drizzle(pool) };
}
