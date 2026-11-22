import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

const database = new URL(process.env.DATABASE_URL);
assert.ok(
  ["postgres:", "postgresql:"].includes(database.protocol) &&
    database.hostname === "127.0.0.1" &&
    database.pathname === "/kinlilo_staging" &&
    !database.search &&
    !database.hash,
  "Staging smoke requires a dedicated loopback kinlilo_staging database.",
);

const api = new URL(process.env.KINLILO_API_URL);
const web = new URL(process.env.KINLILO_WEB_URL);
for (const url of [api, web]) {
  assert.ok(
    url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port,
    "Staging smoke requires explicit loopback HTTP origins.",
  );
}
assert.notEqual(api.port, web.port, "Staging API and web ports must differ.");

function startService(folder, args) {
  return spawn(process.execPath, args, {
    cwd: new URL(`../apps/${folder}/`, import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      KINLILO_API_HOST: api.hostname,
      KINLILO_API_PORT: api.port,
    },
    stdio: "inherit",
  });
}

async function waitUntilReady(service, url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.ok(
      service.exitCode === null && service.signalCode === null,
      `Service exited before serving ${url}.`,
    );
    const response = await globalThis
      .fetch(url, { signal: globalThis.AbortSignal.timeout(1_000) })
      .catch(() => null);
    if (response?.ok) {
      await response.body?.cancel();
      return;
    }
    await response?.body?.cancel();
    await delay(500);
  }
  assert.fail(`Service did not become ready at ${url}.`);
}

function throughWeb(path, { cookie, body } = {}) {
  const headers = { Origin: web.origin };
  if (cookie) headers.Cookie = cookie;
  if (body) headers["Content-Type"] = "application/json";
  return globalThis.fetch(new URL(path, web), {
    headers,
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    signal: globalThis.AbortSignal.timeout(5_000),
  });
}

const apiProcess = startService("api", ["--import", "tsx", "src/server.ts"]);
const webProcess = startService("web", [
  "node_modules/next/dist/bin/next",
  "start",
  "--hostname",
  web.hostname,
  "--port",
  web.port,
]);

try {
  await waitUntilReady(apiProcess, new URL("/health", api));
  await waitUntilReady(webProcess, web);

  const fixture = randomUUID();
  const signup = await throughWeb("/api/auth/sign-up/email", {
    body: { name: "Staging Viewer", email: `${fixture}@example.test`, password: randomUUID() },
  });
  assert.equal(signup.status, 200, "Sign-up through the web proxy failed.");
  const session = signup.headers.getSetCookie().find((value) => /kinlilo\.session_token=/.test(value));
  assert.ok(session, "The web proxy did not return a session cookie.");
  assert.match(session, /;\s*HttpOnly\b/i);
  assert.match(session, /;\s*Secure\b/i);
  const cookie = session.split(";")[0];

  const create = await throughWeb("/v1/circles", { cookie, body: { name: `Staging circle ${fixture}` } });
  assert.equal(create.status, 201, "Circle creation through the web proxy failed.");
  const circle = await create.json();

  const locationsPath = `/v1/circles/${circle.id}/locations`;
  const anonymous = await throughWeb(locationsPath);
  assert.equal(anonymous.status, 401, "The web proxy returned locations without a session.");
  const locations = await throughWeb(locationsPath, { cookie });
  assert.equal(locations.status, 200, "The circle locations route failed.");
  assert.equal(locations.headers.get("cache-control"), "private, no-store");
  const { members } = await locations.json();
  assert.equal(members.length, 1);
  assert.equal(members[0].status, "off");
  assert.equal(members[0].fix, null);
  console.log("Staging web proxy, sign-up, circle access, and private location response verified.");
} finally {
  webProcess.kill();
  apiProcess.kill();
}
