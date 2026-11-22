import { getMigrations } from "better-auth/db/migration";
import { readFile } from "node:fs/promises";
import { createAuth } from "./auth";
import { readConfig } from "./config";
import { connectDatabase } from "./db";

const config = readConfig();
const { pool } = connectDatabase(config.databaseUrl);
const connection = await pool.connect();
const migrations = [
  { version: 1, filename: "001-circles.sql" },
  { version: 2, filename: "002-sharing.sql" },
  { version: 3, filename: "003-location.sql" },
];

try {
  // Keep simultaneous local migration runs from changing the schema concurrently.
  await connection.query("SELECT pg_advisory_lock(1647320071)");
  const auth = createAuth(config, pool);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  await connection.query("BEGIN");
  await connection.query("CREATE TABLE IF NOT EXISTS kinlilo_migrations (version integer PRIMARY KEY)");
  const applied = await connection.query<{ version: number }>("SELECT version FROM kinlilo_migrations");
  const appliedVersions = new Set(applied.rows.map((row) => row.version));
  for (const { version, filename } of migrations) {
    if (appliedVersions.has(version)) continue;
    const migration = await readFile(new URL("../migrations/" + filename, import.meta.url), "utf8");
    await connection.query(migration);
    await connection.query("INSERT INTO kinlilo_migrations (version) VALUES ($1)", [version]);
  }
  await connection.query("COMMIT");
  console.log("Kinlilo database is ready.");
} catch (error) {
  await connection.query("ROLLBACK");
  throw error;
} finally {
  await connection.query("SELECT pg_advisory_unlock(1647320071)");
  connection.release();
  await pool.end();
}
