import assert from "node:assert/strict";
import type { CircleSharing, Device } from "@kinlilo/contracts";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../src/app";
import { readConfig } from "../src/config";

test("accounts, private circles, and atomic invitations on PostgreSQL", async t => {
  const testDatabase = new URL(process.env.KINLILO_TEST_DATABASE_URL ?? "postgresql://kinlilo:kinlilo@127.0.0.1:54399/kinlilo_test");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(testDatabase.hostname) ||
      testDatabase.pathname !== "/kinlilo_test" || testDatabase.search || testDatabase.hash) {
    throw new Error("Integration tests require an isolated loopback kinlilo_test database.");
  }
  const config = { ...readConfig(), databaseUrl: testDatabase.toString() };
  const { app, pool } = createApp(config);
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
  });
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const fixture = randomUUID();
  const password = fixture + "!review";

  async function request(path: string, options: {
    cookie?: string;
    data?: object;
    origin?: string | null;
    mobile?: boolean;
    expoAuth?: boolean;
  } = {}) {
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
    return { status: response.status, body, cookie: response.headers.getSetCookie().map(line => line.split(";")[0]).join("; ") };
  }

  const signup = (name: string) => request("/api/auth/sign-up/email", {
    data: { name, email: name.toLowerCase() + "." + fixture + "@example.test", password },
  });
  const [owner, first, second] = await Promise.all([signup("Maya"), signup("Sam"), signup("Jordan")]);
  for (const user of [owner, first, second]) {
    assert.equal(user.status, 200, JSON.stringify(user.body));
    assert.match(user.cookie, /kinlilo\.session_token=/);
  }
  const loggedIn = await request("/api/auth/sign-in/email", {
    origin: null, expoAuth: true,
    data: { email: "maya." + fixture + "@example.test", password },
  });
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.cookie, /kinlilo\.session_token=/);
  assert.equal((await request("/api/auth/sign-in/email", {
    data: { email: "maya." + fixture + "@example.test", password: "Incorrect-password" },
  })).status, 401);
  assert.equal((await request("/v1/circles")).status, 401);

  const create = await request("/v1/circles", {
    cookie: loggedIn.cookie, origin: null, mobile: true, data: { name: "  Home circle  " },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal(create.body.name, "Home circle");
  assert.equal(create.body.role, "owner");
  const path = "/v1/circles/" + create.body.id;
  assert.equal((await request(path, { cookie: first.cookie })).status, 404);
  assert.equal((await request("/v1/circles", { cookie: first.cookie })).body.circles.length, 0);
  assert.equal((await request(path + "/invites", {
    cookie: owner.cookie, origin: "https://untrusted.example", data: {},
  })).status, 403);

  const invite = () => request(path + "/invites", { cookie: owner.cookie, data: {} });
  const join = (cookie: string, code: string) => request("/v1/circles/join", { cookie, data: { code } });
  const raceInvite = await invite();
  assert.equal(raceInvite.status, 201, JSON.stringify(raceInvite.body));
  const code = raceInvite.body.code as string;
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const hash = createHash("sha256").update(code).digest("hex");
  assert.deepEqual((await pool.query("SELECT token_hash FROM circle_invites WHERE token_hash = $1", [hash])).rows, [{ token_hash: hash }]);

  const race = await Promise.all([join(first.cookie, code), join(second.cookie, code)]);
  assert.deepEqual(race.map(result => result.status).sort(), [201, 404]);
  const winner = race[0].status === 201 ? first : second;
  const loser = winner === first ? second : first;
  assert.equal((await request(path, { cookie: loser.cookie })).status, 404);
  assert.equal((await request(path + "/sharing", { cookie: loser.cookie })).status, 404);
  const roster = await request(path, { cookie: winner.cookie });
  assert.equal(roster.status, 200);
  assert.equal(roster.body.memberCount, 2);
  assert.equal(roster.body.members.some((member: { email?: string }) => "email" in member), false);
  assert.equal((await request(path + "/invites", { cookie: winner.cookie, data: {} })).status, 403);

  const secondInvite = (await invite()).body.code as string;
  assert.equal((await join(winner.cookie, secondInvite)).status, 409);
  assert.equal((await join(loser.cookie, secondInvite)).status, 201);

  const expired = (await invite()).body.code as string;
  await pool.query("UPDATE circle_invites SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
    [createHash("sha256").update(expired).digest("hex")]);
  assert.equal((await join(winner.cookie, expired)).status, 404);

  assert.equal((await request(path + "/leave", { cookie: owner.cookie, data: {} })).status, 409);
  await t.test("sharing starts off and only the member can change it", async () => {
    const register = (cookie: string, installationId: string, label = "Test iPhone") =>
      request("/v1/devices", { cookie, data: { installationId, label } });
    const revoke = (cookie: string, id: string) => request(`/v1/devices/${id}/revoke`, { cookie, data: {} });
    const sharing = (cookie: string, circle = path) => request(circle + "/sharing", { cookie });
    const start = (cookie: string, deviceId: string, version: string, circle = path) =>
      request(circle + "/tracking-sessions", { cookie, data: { deviceId, version } });
    const pause = (cookie: string, id: string) => request(`${path}/tracking-sessions/${id}/pause`, { cookie, data: {} });

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
    assert.equal((await request(path + "/tracking-sessions", {
      cookie: owner.cookie, data: { deviceId: phone.id, version: ownerSharing.version, userId: roster.body.members[0].id },
    })).status, 400);

    const simultaneous = await Promise.all([
      start(winner.cookie, phone.id, initial.version), start(winner.cookie, phone.id, initial.version),
    ]);
    assert.deepEqual(simultaneous.map(result => result.status).sort(), [201, 409]);
    const opened = simultaneous.find(result => result.status === 201)?.body as CircleSharing;
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
    const { rowCount } = await pool.query("SELECT 1 FROM tracking_sessions WHERE id = $1", [leaving.body.activeSession.id]);
    assert.equal(rowCount, 0);

    const rejoin = await join(winner.cookie, (await invite()).body.code);
    assert.equal(rejoin.status, 201);
    const rejoined = await sharing(winner.cookie);
    assert.equal(rejoined.body.activeSession, null);
    assert.notEqual(rejoined.body.version, leaving.body.version);
    assert.equal((await start(winner.cookie, phone.id, leaving.body.version)).status, 409);
    assert.equal((await pause(winner.cookie, leaving.body.activeSession.id)).status, 404);
  });
  assert.equal((await request("/api/auth/sign-out", { cookie: owner.cookie, data: {} })).status, 200);
  assert.equal((await request("/v1/circles", { cookie: owner.cookie })).status, 401);
});
