import assert from "node:assert/strict";
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
  assert.equal((await request(path + "/leave", { cookie: winner.cookie, data: {} })).status, 200);
  assert.equal((await request(path, { cookie: winner.cookie })).status, 404);
  assert.equal((await request("/api/auth/sign-out", { cookie: owner.cookie, data: {} })).status, 200);
  assert.equal((await request("/v1/circles", { cookie: owner.cookie })).status, 401);
});
