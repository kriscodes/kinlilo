import assert from "node:assert/strict";
import type {
  CircleSharing,
  Device,
  LocationBatchResult,
  LocationHistory,
  TrackingSession,
} from "@kinlilo/contracts";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app";
import { readConfig } from "../src/config";

test("accounts, private circles, and atomic invitations on PostgreSQL", async (t) => {
  const testDatabase = new URL(
    process.env.KINLILO_TEST_DATABASE_URL ?? "postgresql://kinlilo:kinlilo@127.0.0.1:54399/kinlilo_test",
  );
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(testDatabase.hostname) ||
    testDatabase.pathname !== "/kinlilo_test" ||
    testDatabase.search ||
    testDatabase.hash
  ) {
    throw new Error("Integration tests require an isolated loopback kinlilo_test database.");
  }
  const config = { ...readConfig(), databaseUrl: testDatabase.toString(), locationRetentionDays: 30 };
  const { app, pool } = createApp(config);
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await pool.end();
  });
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const fixture = randomUUID();
  const password = fixture + "!review";

  async function request(
    path: string,
    options: {
      cookie?: string;
      data?: object;
      origin?: string | null;
      mobile?: boolean;
      expoAuth?: boolean;
    } = {},
  ) {
    const headers = new Headers();
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.mobile) headers.set("X-Kinlilo-Client", "mobile");
    if (options.expoAuth) headers.set("expo-origin", "kinlilo://");
    const origin = options.origin === undefined ? config.webOrigin : options.origin;
    if (origin) headers.set("Origin", origin);
    if (options.data) headers.set("Content-Type", "application/json");
    const response = await fetch(base + path, {
      method: options.data ? "POST" : "GET",
      headers,
      body: options.data ? JSON.stringify(options.data) : undefined,
    });
    const body = await response.json();
    return {
      status: response.status,
      body,
      cacheControl: response.headers.get("cache-control"),
      cookie: response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; "),
    };
  }

  const signup = (name: string) =>
    request("/api/auth/sign-up/email", {
      data: { name, email: name.toLowerCase() + "." + fixture + "@example.test", password },
    });
  const [owner, first, second] = await Promise.all([signup("Maya"), signup("Sam"), signup("Jordan")]);
  for (const user of [owner, first, second]) {
    assert.equal(user.status, 200, JSON.stringify(user.body));
    assert.match(user.cookie, /kinlilo\.session_token=/);
  }
  const loggedIn = await request("/api/auth/sign-in/email", {
    origin: null,
    expoAuth: true,
    data: { email: "maya." + fixture + "@example.test", password },
  });
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.cookie, /kinlilo\.session_token=/);
  assert.equal(
    (
      await request("/api/auth/sign-in/email", {
        data: { email: "maya." + fixture + "@example.test", password: "Incorrect-password" },
      })
    ).status,
    401,
  );
  assert.equal((await request("/v1/circles")).status, 401);

  const create = await request("/v1/circles", {
    cookie: loggedIn.cookie,
    origin: null,
    mobile: true,
    data: { name: "  Home circle  " },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal(create.body.name, "Home circle");
  assert.equal(create.body.role, "owner");
  const path = "/v1/circles/" + create.body.id;
  assert.equal((await request(path, { cookie: first.cookie })).status, 404);
  assert.equal((await request("/v1/circles", { cookie: first.cookie })).body.circles.length, 0);
  assert.equal(
    (
      await request(path + "/invites", {
        cookie: owner.cookie,
        origin: "https://untrusted.example",
        data: {},
      })
    ).status,
    403,
  );

  const invite = () => request(path + "/invites", { cookie: owner.cookie, data: {} });
  const join = (cookie: string, code: string) => request("/v1/circles/join", { cookie, data: { code } });
  const raceInvite = await invite();
  assert.equal(raceInvite.status, 201, JSON.stringify(raceInvite.body));
  const code = raceInvite.body.code as string;
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const hash = createHash("sha256").update(code).digest("hex");
  assert.deepEqual(
    (await pool.query("SELECT token_hash FROM circle_invites WHERE token_hash = $1", [hash])).rows,
    [{ token_hash: hash }],
  );

  const race = await Promise.all([join(first.cookie, code), join(second.cookie, code)]);
  assert.deepEqual(race.map((result) => result.status).sort(), [201, 404]);
  const winner = race[0].status === 201 ? first : second;
  const loser = winner === first ? second : first;
  assert.equal((await request(path, { cookie: loser.cookie })).status, 404);
  assert.equal((await request(path + "/locations", { cookie: loser.cookie })).status, 404);
  assert.equal((await request(path + "/sharing", { cookie: loser.cookie })).status, 404);
  const roster = await request(path, { cookie: winner.cookie });
  assert.equal(roster.status, 200);
  assert.equal(roster.body.memberCount, 2);
  assert.equal(
    roster.body.members.some((member: { email?: string }) => "email" in member),
    false,
  );
  assert.equal((await request(path + "/invites", { cookie: winner.cookie, data: {} })).status, 403);

  const secondInvite = (await invite()).body.code as string;
  assert.equal((await join(winner.cookie, secondInvite)).status, 409);
  assert.equal((await join(loser.cookie, secondInvite)).status, 201);

  const expired = (await invite()).body.code as string;
  await pool.query(
    "UPDATE circle_invites SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
    [createHash("sha256").update(expired).digest("hex")],
  );
  assert.equal((await join(winner.cookie, expired)).status, 404);

  assert.equal((await request(path + "/leave", { cookie: owner.cookie, data: {} })).status, 409);
  await t.test("sharing starts off and only the member can change it", async () => {
    const register = (cookie: string, installationId: string, label = "Test iPhone") =>
      request("/v1/devices", { cookie, data: { installationId, label } });
    const revoke = (cookie: string, id: string) => request(`/v1/devices/${id}/revoke`, { cookie, data: {} });
    const sharing = (cookie: string, circle = path) => request(circle + "/sharing", { cookie });
    const start = (cookie: string, deviceId: string, version: string, circle = path) =>
      request(circle + "/tracking-sessions", { cookie, data: { deviceId, version } });
    const pause = (cookie: string, id: string) =>
      request(`${path}/tracking-sessions/${id}/pause`, { cookie, data: {} });

    assert.equal((await request("/v1/devices")).status, 401);
    const { body: initial } = await sharing(winner.cookie);
    const { body: ownerSharing } = await sharing(owner.cookie);
    assert.equal(initial.activeSession, null);
    assert.equal(ownerSharing.activeSession, null);

    const installation = randomUUID();
    const firstPhone = await register(winner.cookie, installation, "  Phone one  ");
    assert.equal(firstPhone.status, 201);
    const phone = firstPhone.body as Device;
    assert.equal(phone.label, "Phone one");
    const repeated = await register(winner.cookie, installation, "Different label");
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body, phone);
    const secondInstallation = randomUUID();
    const sparePhone = await register(winner.cookie, secondInstallation);
    assert.equal(sparePhone.status, 201);
    const spare = sparePhone.body as Device;
    assert.deepEqual((await request("/v1/devices", { cookie: owner.cookie })).body.devices, []);
    assert.equal((await start(owner.cookie, phone.id, ownerSharing.version)).status, 404);
    assert.equal((await revoke(owner.cookie, phone.id)).status, 404);
    assert.equal(
      (
        await request(path + "/tracking-sessions", {
          cookie: owner.cookie,
          data: { deviceId: phone.id, version: ownerSharing.version, userId: roster.body.members[0].id },
        })
      ).status,
      400,
    );

    const simultaneous = await Promise.all([
      start(winner.cookie, phone.id, initial.version),
      start(winner.cookie, phone.id, initial.version),
    ]);
    assert.deepEqual(simultaneous.map((result) => result.status).sort(), [201, 409]);
    const opened = simultaneous.find((result) => result.status === 201)?.body as CircleSharing;
    assert.ok(opened.activeSession);
    assert.equal(opened.activeSession.deviceId, phone.id);
    assert.equal((await pause(owner.cookie, opened.activeSession.id)).status, 404);
    assert.deepEqual((await sharing(owner.cookie)).body, ownerSharing);

    const replacement = await start(winner.cookie, spare.id, opened.version);
    assert.equal(replacement.status, 201);
    const replaced = replacement.body as CircleSharing;
    assert.ok(replaced.activeSession);
    assert.notEqual(replaced.activeSession.id, opened.activeSession.id);
    assert.equal(replaced.activeSession.deviceId, spare.id);
    assert.deepEqual((await pause(winner.cookie, opened.activeSession.id)).body, replaced);
    const paused = await pause(winner.cookie, replaced.activeSession.id);
    assert.equal(paused.status, 200);
    assert.equal(paused.body.activeSession, null);
    assert.notEqual(paused.body.version, replaced.version);
    assert.deepEqual((await pause(winner.cookie, replaced.activeSession.id)).body, paused.body);
    assert.equal((await start(winner.cookie, spare.id, replaced.version)).status, 409);
    const resumed = await start(winner.cookie, spare.id, paused.body.version);
    assert.equal(resumed.status, 201);

    const other = await request("/v1/circles", { cookie: winner.cookie, data: { name: "Second circle" } });
    assert.equal(other.status, 201);
    const otherPath = `/v1/circles/${other.body.id}`;
    const otherState = await sharing(winner.cookie, otherPath);
    const otherStarted = await start(winner.cookie, spare.id, otherState.body.version, otherPath);
    assert.equal(otherStarted.status, 201);
    const revoked = await revoke(winner.cookie, spare.id);
    assert.equal(revoked.status, 200);
    assert.ok(revoked.body.revokedAt);
    assert.deepEqual((await revoke(winner.cookie, spare.id)).body, revoked.body);
    assert.equal((await register(winner.cookie, secondInstallation)).status, 409);
    const afterRevoke = await sharing(winner.cookie);
    const otherAfterRevoke = await sharing(winner.cookie, otherPath);
    assert.equal(afterRevoke.body.activeSession, null);
    assert.equal(otherAfterRevoke.body.activeSession, null);
    assert.notEqual(afterRevoke.body.version, resumed.body.version);
    assert.notEqual(otherAfterRevoke.body.version, otherStarted.body.version);
    assert.equal((await start(winner.cookie, spare.id, afterRevoke.body.version)).status, 409);

    const racePhone = (await register(winner.cookie, randomUUID())).body as Device;
    const [racingStart, racingRevoke] = await Promise.all([
      start(winner.cookie, racePhone.id, otherAfterRevoke.body.version, otherPath),
      revoke(winner.cookie, racePhone.id),
    ]);
    assert.ok([201, 409].includes(racingStart.status));
    assert.equal(racingRevoke.status, 200);
    assert.equal((await sharing(winner.cookie, otherPath)).body.activeSession, null);

    const leaving = await start(winner.cookie, phone.id, afterRevoke.body.version);
    assert.equal(leaving.status, 201);
    assert.equal((await request(path + "/leave", { cookie: winner.cookie, data: {} })).status, 200);
    assert.equal((await request(path, { cookie: winner.cookie })).status, 404);
    assert.equal((await sharing(winner.cookie)).status, 404);
    const { rowCount } = await pool.query("SELECT 1 FROM tracking_sessions WHERE id = $1", [
      leaving.body.activeSession.id,
    ]);
    assert.equal(rowCount, 0);

    const rejoin = await join(winner.cookie, (await invite()).body.code);
    assert.equal(rejoin.status, 201);
    const rejoined = await sharing(winner.cookie);
    assert.equal(rejoined.body.activeSession, null);
    assert.notEqual(rejoined.body.version, leaving.body.version);
    assert.equal((await start(winner.cookie, phone.id, leaving.body.version)).status, 409);
    assert.equal((await pause(winner.cookie, leaving.body.activeSession.id)).status, 404);
  });

  await t.test("active sessions ingest location batches without moving the latest fix backward", async () => {
    const cookie = winner.cookie;
    const userId = winner.body.user.id as string;
    const circleId = create.body.id as string;
    const sharing = () => request(path + "/sharing", { cookie });
    const sessionsPath = path + "/tracking-sessions";
    const getLocations = (viewer = owner.cookie) => request(path + "/locations", { cookie: viewer });
    const memberLocation = async (viewer = owner.cookie) => {
      const response = await getLocations(viewer);
      assert.equal(response.status, 200);
      return response.body.members.find((member: { id: string }) => member.id === userId);
    };
    const register = async () => {
      const response = await request("/v1/devices", {
        cookie,
        data: { installationId: randomUUID(), label: "Location test" },
      });
      assert.equal(response.status, 201);
      return response.body as Device;
    };
    const start = async (device: Device) => {
      const { body } = await sharing();
      const response = await request(sessionsPath, {
        cookie,
        data: { deviceId: device.id, version: body.version },
      });
      assert.equal(response.status, 201);
      const state = response.body as CircleSharing;
      assert.ok(state.activeSession);
      return state.activeSession;
    };
    const fix = (session: TrackingSession, offsetMs = 1_000) => ({
      eventId: randomUUID(),
      capturedAt: new Date(Date.parse(session.startedAt) + offsetMs).toISOString(),
      latitude: 12.25,
      longitude: -45.5,
      accuracyM: 4,
    });
    const upload = (session: TrackingSession, events: object[], sessionCookie: string | undefined = cookie) =>
      request("/v1/location-batches", { cookie: sessionCookie, data: { sessionId: session.id, events } });
    const latest = async () =>
      (
        await pool.query<{ event_id: string; captured_at: Date; accuracy_m: number }>(
          `
      SELECT event_id, latest_locations.captured_at, accuracy_m FROM latest_locations
      JOIN location_points ON location_points.id = latest_locations.point_id
      WHERE latest_locations.circle_id = $1 AND latest_locations.user_id = $2
    `,
          [circleId, userId],
        )
      ).rows[0];
    const countPoints = async () =>
      (
        await pool.query<{ points: number }>(
          `
      SELECT count(*)::int AS points FROM location_points WHERE circle_id = $1 AND user_id = $2
    `,
          [circleId, userId],
        )
      ).rows[0].points;

    const phone = await register();
    const spare = await register();
    assert.equal((await getLocations("")).status, 401);
    assert.equal((await memberLocation()).status, "off");
    const firstSession = await start(phone);
    assert.deepEqual(await memberLocation(), {
      id: userId,
      name: winner.body.user.name,
      role: "member",
      status: "unavailable",
      fix: null,
    });
    const newest = fix(firstSession, 3_000);
    const older = fix(firstSession);
    const beforeSession = fix(firstSession, -1);
    const future = fix(firstSession, 60 * 60 * 1_000);
    assert.equal((await upload(firstSession, [newest], "")).status, 401);
    assert.equal((await upload(firstSession, [newest], owner.cookie)).status, 404);
    assert.equal((await upload(firstSession, [newest, { ...older, latitude: 91 }])).status, 400);
    assert.equal((await upload(firstSession, [{ ...older, accuracyM: -1 }])).status, 400);
    assert.equal((await upload(firstSession, [{ ...older, extra: "x".repeat(33_000) }])).status, 413);
    assert.equal(await countPoints(), 0);

    const batch = await upload(firstSession, [
      newest,
      beforeSession,
      { ...newest, eventId: newest.eventId.toUpperCase() },
      future,
    ]);
    assert.equal(batch.status, 200);
    const receipt = batch.body as LocationBatchResult;
    assert.ok(Number.isFinite(Date.parse(receipt.serverTime)));
    assert.deepEqual(receipt.results, [
      { eventId: newest.eventId, status: "accepted" },
      { eventId: beforeSession.eventId, status: "rejected", reason: "before_session" },
      { eventId: newest.eventId.toUpperCase(), status: "duplicate" },
      { eventId: future.eventId, status: "rejected", reason: "future_timestamp" },
    ]);
    const duplicateRace = await Promise.all([upload(firstSession, [older]), upload(firstSession, [older])]);
    assert.deepEqual(
      duplicateRace.map((response) => response.status),
      [200, 200],
    );
    assert.deepEqual(duplicateRace.map((response) => response.body.results[0].status).sort(), [
      "accepted",
      "duplicate",
    ]);
    const retry = await upload(firstSession, Array(100).fill(newest));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.results.length, 100);
    assert.ok((retry.body as LocationBatchResult).results.every((result) => result.status === "duplicate"));
    assert.equal((await upload(firstSession, Array(101).fill(newest))).status, 400);
    assert.deepEqual((await upload(firstSession, [{ ...newest, accuracyM: 8 }])).body.results, [
      { eventId: newest.eventId, status: "rejected", reason: "event_conflict" },
    ]);
    assert.equal(await countPoints(), 2);
    assert.deepEqual(await latest(), {
      event_id: newest.eventId,
      captured_at: new Date(newest.capturedAt),
      accuracy_m: 4,
    });
    assert.equal((await getLocations()).cacheControl, "private, no-store");
    assert.deepEqual(await memberLocation(), {
      id: userId,
      name: winner.body.user.name,
      role: "member",
      status: "recent",
      fix: {
        latitude: newest.latitude,
        longitude: newest.longitude,
        accuracyM: newest.accuracyM,
        capturedAt: newest.capturedAt,
      },
    });
    // Set the later viewer's join boundary just past the fixture's capture time.
    await pool.query("UPDATE circle_memberships SET joined_at = $1 WHERE circle_id = $2 AND user_id = $3", [
      new Date(Date.parse(newest.capturedAt) + 1),
      circleId,
      loser.body.user.id,
    ]);
    assert.equal((await memberLocation(loser.cookie)).fix, null);
    assert.equal((await memberLocation(loser.cookie)).status, "unavailable");

    assert.equal(
      (await request(`${sessionsPath}/${firstSession.id}/pause`, { cookie, data: {} })).status,
      200,
    );
    assert.equal(await latest(), undefined);
    assert.equal((await memberLocation()).status, "paused");
    assert.equal((await memberLocation()).fix, null);
    assert.equal(await countPoints(), 2);
    assert.equal((await upload(firstSession, [newest])).status, 404);
    const resumed = await start(phone);
    assert.equal((await memberLocation()).status, "unavailable");
    const fresh = fix(resumed);
    assert.deepEqual((await upload(resumed, [{ ...fresh, eventId: newest.eventId }, fresh])).body.results, [
      { eventId: newest.eventId, status: "rejected", reason: "event_conflict" },
      { eventId: fresh.eventId, status: "accepted" },
    ]);
    assert.equal((await latest())?.event_id, fresh.eventId);

    const replacement = await start(spare);
    assert.equal(await latest(), undefined);
    assert.equal((await memberLocation()).status, "unavailable");
    assert.equal((await upload(resumed, [fresh])).status, 404);
    const spareFix = fix(replacement);
    assert.equal((await upload(replacement, [spareFix])).status, 200);
    assert.equal((await latest())?.event_id, spareFix.eventId);
    const [racingUpload, revoked] = await Promise.all([
      upload(replacement, [fix(replacement, 2_000)]),
      request(`/v1/devices/${spare.id}/revoke`, { cookie, data: {} }),
    ]);
    assert.ok([200, 404].includes(racingUpload.status));
    assert.equal(revoked.status, 200);
    assert.equal((await upload(replacement, [spareFix])).status, 404);
    assert.equal(await latest(), undefined);
    assert.equal((await memberLocation()).status, "paused");

    const leaving = await start(phone);
    assert.equal((await upload(leaving, [fix(leaving)])).body.results[0].status, "accepted");
    assert.equal((await request(path + "/leave", { cookie, data: {} })).status, 200);
    assert.equal((await upload(leaving, [fix(leaving)])).status, 404);
    assert.equal(await latest(), undefined);
    assert.equal(await countPoints(), 0);
    assert.equal((await getLocations(cookie)).status, 404);
    assert.equal(await memberLocation(), undefined);

    const ownerDevice = await request("/v1/devices", {
      cookie: owner.cookie,
      data: { installationId: randomUUID(), label: "Freshness test" },
    });
    const ownerSharing = await request(path + "/sharing", { cookie: owner.cookie });
    const ownerStart = await request(sessionsPath, {
      cookie: owner.cookie,
      data: { deviceId: ownerDevice.body.id, version: ownerSharing.body.version },
    });
    assert.equal(ownerStart.status, 201);
    const ownerSession = ownerStart.body.activeSession as TrackingSession;
    const getOwner = async () =>
      (await getLocations()).body.members.find((member: { id: string }) => member.id === owner.body.user.id);
    const earlier = new Date(Date.now() - 60 * 60_000);
    await pool.query("UPDATE circle_memberships SET joined_at = $1 WHERE circle_id = $2 AND user_id = $3", [
      earlier,
      circleId,
      owner.body.user.id,
    ]);
    await pool.query("UPDATE tracking_sessions SET started_at = $1 WHERE id = $2", [
      earlier,
      ownerSession.id,
    ]);
    for (const [minutes, status] of [
      [30, "stale"],
      [5, "delayed"],
    ] as const) {
      const capturedAt = new Date(Date.now() - minutes * 60_000).toISOString();
      const point = { ...fix(ownerSession), capturedAt };
      assert.equal((await upload(ownerSession, [point], owner.cookie)).body.results[0].status, "accepted");
      const latestOwner = await getOwner();
      assert.equal(latestOwner.status, status);
      assert.equal(latestOwner.fix.capturedAt, capturedAt);
    }
  });

  await t.test("location history filters by date and rechecks sharing on each page", async () => {
    const circleId = create.body.id as string;
    const memberId = owner.body.user.id as string;
    const historyPath = `${path}/members/${memberId}/history`;
    const dayMs = 24 * 60 * 60_000;
    const day = new Date(Date.now() - 2 * dayMs);
    day.setUTCHours(0, 0, 0, 0);
    const at = (offset: number) => new Date(day.getTime() + offset).toISOString();
    const query = { from: at(0), to: at(dayMs) };
    const history = (cookie: string, filter = query, cursor?: string, resource = historyPath) => {
      const params = new URLSearchParams(filter);
      if (cursor) params.set("cursor", cursor);
      return request(`${resource}?${params}`, { cookie });
    };

    assert.equal((await history("")).status, 401);
    assert.equal((await history(winner.cookie)).status, 404);
    assert.equal(
      (await history(owner.cookie, query, undefined, `${path}/members/${winner.body.user.id}/history`))
        .status,
      404,
    );
    assert.equal((await history(owner.cookie, { from: query.to, to: query.from })).status, 400);
    assert.equal((await history(owner.cookie, { from: query.from, to: at(2 * dayMs) })).status, 400);
    assert.equal((await history(owner.cookie, query, "invalid-cursor")).status, 400);
    assert.equal(
      (await history(owner.cookie, { from: query.from, to: at(dayMs + 60 * 60_000) })).status,
      200,
    );
    assert.equal(
      (
        await request(`${historyPath}?${new URLSearchParams(query)}&_=${Date.now()}`, {
          cookie: owner.cookie,
          origin: null,
          mobile: true,
        })
      ).status,
      200,
    );

    const sharing = await request(path + "/sharing", { cookie: owner.cookie });
    const session = sharing.body.activeSession as TrackingSession;
    const expired = at(-31 * dayMs);
    await pool.query("UPDATE tracking_sessions SET started_at = $1 WHERE id = $2", [expired, session.id]);
    await pool.query("UPDATE circle_memberships SET joined_at = $1 WHERE circle_id = $2 AND user_id = $3", [
      expired,
      circleId,
      memberId,
    ]);
    await pool.query("UPDATE circle_memberships SET joined_at = $1 WHERE circle_id = $2 AND user_id = $3", [
      at(1),
      circleId,
      loser.body.user.id,
    ]);
    // Seed fixes on each boundary and more than a page at the exact same millisecond.
    const stored = await pool.query<{ id: string; captured_at: Date }>(
      `
      INSERT INTO location_points (id, session_id, circle_id, user_id, device_id, event_id, captured_at, received_at, latitude, longitude, accuracy_m)
      SELECT gen_random_uuid(), s.id, s.circle_id, s.user_id, s.device_id, gen_random_uuid(), fixture.captured_at, now(), 35, -120, 8
      FROM tracking_sessions s CROSS JOIN unnest($2::timestamptz[]) AS fixture(captured_at)
      WHERE s.id = $1
      RETURNING id, captured_at
    `,
      [session.id, [expired, at(-1), at(0), ...Array<string>(102).fill(at(1)), at(dayMs)]],
    );

    const first = await history(loser.cookie);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.cacheControl, "private, no-store");
    const firstPage = first.body as LocationHistory;
    assert.equal(firstPage.status, "available");
    assert.equal(firstPage.points.length, 100);
    assert.ok(firstPage.nextCursor);
    const second = await history(loser.cookie, query, firstPage.nextCursor);
    assert.equal(second.status, 200);
    const secondPage = second.body as LocationHistory;
    assert.equal(secondPage.nextCursor, null);
    const points = [...firstPage.points, ...secondPage.points];
    const expected = stored.rows
      .filter((row) => row.captured_at.toISOString() === at(1))
      .map((row) => row.id)
      .sort();
    assert.deepEqual(
      points.map((point) => point.id),
      expected,
    );
    assert.ok(
      points.every(
        (point) =>
          point.capturedAt === at(1) && point.segment === points[0].segment && !("sessionId" in point),
      ),
    );

    const own = await history(owner.cookie);
    assert.equal(own.status, 200);
    assert.equal(own.body.points[0].capturedAt, query.from);
    const adjacent = await history(owner.cookie, { from: query.to, to: at(2 * dayMs) });
    assert.deepEqual(
      adjacent.body.points.map((point: { capturedAt: string }) => point.capturedAt),
      [query.to],
    );
    const old = await history(owner.cookie, { from: expired, to: at(-30 * dayMs) });
    assert.deepEqual(old.body, { status: "available", points: [], nextCursor: null });

    assert.equal(
      (await request(`${path}/tracking-sessions/${session.id}/pause`, { cookie: owner.cookie, data: {} }))
        .status,
      200,
    );
    const paused = await history(loser.cookie, query, firstPage.nextCursor);
    assert.equal(paused.status, 200);
    assert.deepEqual(paused.body, { status: "sharing_off", points: [], nextCursor: null });
    assert.deepEqual((await history(owner.cookie)).body, own.body);
  });

  assert.equal((await request("/api/auth/sign-out", { cookie: owner.cookie, data: {} })).status, 200);
  assert.equal((await request("/v1/circles", { cookie: owner.cookie })).status, 401);
});
