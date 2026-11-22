import { acceptInvite, circleId, createCircle } from "@kinlilo/contracts";
import { and, asc, count, eq, gt, isNull, sql } from "drizzle-orm";
import { Router } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authUsers, circles, invites, lockAccount, memberships, type Database } from "./db";
type Locals = { userId: string };

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseCircleId(value: unknown) {
  const parsed = circleId.safeParse(value);
  if (!parsed.success) throw new RequestError(404, "Circle not found.");
  return parsed.data;
}

function hashCode(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

export function createCirclesRouter(db: Database) {
  const router = Router();

  async function getCircleSummaryForMember(requestedCircleId: string, userId: string) {
    const [circle] = await db
      .select({
        id: circles.id,
        name: circles.name,
        role: memberships.role,
        memberCount: db.$count(memberships, eq(memberships.circleId, circles.id)),
      })
      .from(memberships)
      .innerJoin(circles, eq(circles.id, memberships.circleId))
      .where(and(eq(memberships.userId, userId), eq(memberships.circleId, requestedCircleId)));

    if (!circle) throw new RequestError(404, "Circle not found.");
    return circle;
  }

  router.get<object, unknown, unknown, unknown, Locals>("/", async (_req, res) => {
    const result = await db
      .select({
        id: circles.id,
        name: circles.name,
        role: memberships.role,
        memberCount: db.$count(memberships, eq(memberships.circleId, circles.id)),
      })
      .from(memberships)
      .innerJoin(circles, eq(circles.id, memberships.circleId))
      .where(eq(memberships.userId, res.locals.userId))
      .orderBy(asc(circles.name), asc(circles.id));
    res.json({ circles: result });
  });

  router.post<object, unknown, unknown, unknown, Locals>("/", async (req, res) => {
    const parsed = createCircle.safeParse(req.body);
    if (!parsed.success) throw new RequestError(400, "Enter a circle name of 1 to 60 characters.");
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(circles).values({ id, name: parsed.data.name });
      await tx.insert(memberships).values({ circleId: id, userId: res.locals.userId, role: "owner" });
    });
    res.status(201).json({ id, name: parsed.data.name, role: "owner", memberCount: 1 });
  });

  router.post<object, unknown, unknown, unknown, Locals>("/join", async (req, res) => {
    const parsed = acceptInvite.safeParse(req.body);
    if (!parsed.success) throw new RequestError(400, "Enter a valid invitation code.");
    const tokenHash = hashCode(parsed.data.code);
    const userId = res.locals.userId;

    const joined = await db.transaction(async (tx) => {
      // The conditional update locks the invite row and lets only one transaction claim it.
      const [claimed] = await tx
        .update(invites)
        .set({ redeemedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(invites.tokenHash, tokenHash),
            isNull(invites.redeemedAt),
            gt(invites.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ circleId: invites.circleId });
      if (!claimed) throw new RequestError(404, "This invitation is invalid, expired, or already used.");

      const [member] = await tx
        .insert(memberships)
        .values({ circleId: claimed.circleId, userId, role: "member" })
        .onConflictDoNothing()
        .returning({ circleId: memberships.circleId });
      // Roll back the claim if this account already belongs to the circle.
      if (!member) throw new RequestError(409, "You already belong to this circle.");

      const [circle] = await tx
        .select({ id: circles.id, name: circles.name })
        .from(circles)
        .where(eq(circles.id, member.circleId));
      const [{ memberCount }] = await tx
        .select({ memberCount: count() })
        .from(memberships)
        .where(eq(memberships.circleId, member.circleId));
      return { ...circle, role: "member", memberCount };
    });
    res.status(201).json(joined);
  });

  router.get<{ id: string }, unknown, unknown, unknown, Locals>("/:id", async (req, res) => {
    const id = parseCircleId(req.params.id);
    const userId = res.locals.userId;
    const circle = await getCircleSummaryForMember(id, userId);
    const viewer = db
      .select({ id: memberships.circleId })
      .from(memberships)
      .where(and(eq(memberships.circleId, id), eq(memberships.userId, userId)));
    const members = await db
      .select({
        id: memberships.userId,
        name: authUsers.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
      .where(and(eq(memberships.circleId, id), sql`exists (${viewer})`))
      .orderBy(asc(authUsers.name), asc(memberships.userId));
    if (!members.some((member) => member.id === userId)) throw new RequestError(404, "Circle not found.");
    res.json({ ...circle, members, memberCount: members.length });
  });

  router.post<{ id: string }, unknown, unknown, unknown, Locals>("/:id/invites", async (req, res) => {
    const id = parseCircleId(req.params.id);
    const circle = await getCircleSummaryForMember(id, res.locals.userId);
    if (circle.role !== "owner") throw new RequestError(403, "Only the circle owner can create invitations.");

    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(invites).values({ tokenHash: hashCode(code), circleId: id, expiresAt });
    res.status(201).json({ code, expiresAt: expiresAt.toISOString() });
  });

  router.post<{ id: string }, unknown, unknown, unknown, Locals>("/:id/leave", async (req, res) => {
    const id = parseCircleId(req.params.id);
    const circle = await getCircleSummaryForMember(id, res.locals.userId);
    if (circle.role === "owner") throw new RequestError(409, "The owner cannot leave their circle.");
    const userId = res.locals.userId;
    await db.transaction(async (tx) => {
      if (!(await lockAccount(tx, userId))) throw new RequestError(401, "Sign in to continue.");
      const [removed] = await tx
        .delete(memberships)
        .where(
          and(eq(memberships.circleId, id), eq(memberships.userId, userId), eq(memberships.role, "member")),
        )
        .returning({ id: memberships.userId });
      if (!removed) throw new RequestError(404, "Circle not found.");
    });
    res.json({ ok: true });
  });

  return router;
}

export { RequestError };
