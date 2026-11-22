import { locationEvent, type LocationEvent } from "@kinlilo/contracts";
import * as Crypto from "expo-crypto";
import type { LocationObject } from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

const keyName = "kinlilo.location-outbox-key";
const keyOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const maximumAgeMs = 48 * 60 * 60 * 1_000;
const maximumFixes = 10_000;
const databaseName = "kinlilo-location-outbox.db";

type LocalSession = { accountId: string; circleId: string; sessionId: string; captureAfter: number };
export type SharingStatus = LocalSession & { phase: "active" | "pausing"; queued: number; dropped: number };

let database: SQLite.SQLiteDatabase | undefined;
let tail: Promise<unknown> = Promise.resolve();

async function openOutbox(create: boolean) {
  if (database) return database;
  let key = await SecureStore.getItemAsync(keyName, keyOptions);
  if (key === null && !create) return null;
  const db = await SQLite.openDatabaseAsync(databaseName, { useNewConnection: true });
  try {
    const cipher = await db.getFirstAsync<{ cipher_version: string }>("PRAGMA cipher_version");
    if (!cipher?.cipher_version) throw new Error("SQLCipher is missing.");
    if (key === null) {
      const bytes = await Crypto.getRandomBytesAsync(32);
      key = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      await SecureStore.setItemAsync(keyName, key, keyOptions);
    }
    // PRAGMA key requires a literal. Only a 256-bit hexadecimal key is accepted here.
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid outbox key.");
    await db.execAsync(`PRAGMA key = "x'${key}'";`);
    await db.execAsync(`
      PRAGMA busy_timeout = 2000;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS installation (id INTEGER PRIMARY KEY CHECK (id = 1), device_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sharing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT NOT NULL,
        circle_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        capture_after INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('active', 'pausing')),
        dropped INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL REFERENCES sharing(session_id) ON DELETE CASCADE,
        captured_at INTEGER NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracy_m REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_time ON outbox (session_id, captured_at, event_id);
      CREATE TRIGGER IF NOT EXISTS discard_paused_fixes AFTER UPDATE OF phase ON sharing
      WHEN NEW.phase = 'pausing' BEGIN
        DELETE FROM outbox WHERE session_id = NEW.session_id;
      END;
    `);
    database = db;
    return db;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

function useDatabase<T>(operation: (db: SQLite.SQLiteDatabase) => Promise<T>, create = false): Promise<T | null> {
  // The keyed connection is shared by the task and the UI. Queue all operations outside transactions.
  const next = tail.then(async () => {
    try {
      const db = await openOutbox(create);
      return db ? await operation(db) : null;
    } catch {
      throw new Error("Encrypted location storage is unavailable. Use a rebuilt iOS app and unlock the device.");
    }
  });
  tail = next.catch(() => {});
  return next;
}

function readStatus(db: SQLite.SQLiteDatabase) {
  return db.getFirstAsync<SharingStatus>(`
    SELECT account_id AS accountId, circle_id AS circleId, session_id AS sessionId,
      capture_after AS captureAfter, phase, dropped,
      (SELECT count(*) FROM outbox WHERE session_id = sharing.session_id) AS queued
    FROM sharing WHERE id = 1
  `);
}

export function getOutboxStatus() {
  return useDatabase(readStatus);
}

export async function getInstallationId() {
  const installation = await useDatabase(async db => {
    await db.runAsync("INSERT OR IGNORE INTO installation (id, device_id) VALUES (1, ?)", Crypto.randomUUID());
    return db.getFirstAsync<{ device_id: string }>("SELECT device_id FROM installation WHERE id = 1");
  }, true);
  if (!installation) throw new Error("Could not register this iPhone.");
  return installation.device_id;
}

export function activateOutbox(session: LocalSession) {
  return useDatabase(db => db.runAsync(`
    INSERT INTO sharing (id, account_id, circle_id, session_id, capture_after, phase)
    VALUES (1, ?, ?, ?, ?, 'active')
  `, session.accountId, session.circleId, session.sessionId, session.captureAfter), true);
}

export function pauseOutbox(sessionId: string) {
  return useDatabase(db => db.runAsync("UPDATE sharing SET phase = 'pausing' WHERE session_id = ?", sessionId));
}

export function removeOutbox(sessionId: string) {
  return useDatabase(db => db.runAsync("DELETE FROM sharing WHERE session_id = ?", sessionId));
}

async function prune(db: SQLite.SQLiteDatabase, sessionId: string) {
  const expired = await db.runAsync("DELETE FROM outbox WHERE session_id = ? AND captured_at < ?", sessionId, Date.now() - maximumAgeMs);
  const excess = await db.runAsync(`
    DELETE FROM outbox WHERE event_id IN (
      SELECT event_id FROM outbox WHERE session_id = ? ORDER BY captured_at DESC, event_id DESC LIMIT -1 OFFSET ?
    )
  `, sessionId, maximumFixes);
  const dropped = expired.changes + excess.changes;
  if (dropped) await db.runAsync("UPDATE sharing SET dropped = dropped + ? WHERE session_id = ?", dropped, sessionId);
}

export function enqueueLocations(fixes: LocationObject[]) {
  return useDatabase(db => db.withTransactionAsync(async () => {
    const state = await readStatus(db);
    if (state?.phase !== "active") return;
    for (const fix of fixes) {
      const date = new Date(fix.timestamp);
      if (!Number.isFinite(date.getTime()) || fix.timestamp < state.captureAfter) continue;
      const { latitude, longitude, accuracy } = fix.coords;
      const event = locationEvent.safeParse({ eventId: Crypto.randomUUID(), capturedAt: date.toISOString(), latitude, longitude, accuracyM: accuracy });
      if (!event.success) continue;
      await db.runAsync(`
        INSERT INTO outbox (event_id, session_id, captured_at, latitude, longitude, accuracy_m) VALUES (?, ?, ?, ?, ?, ?)
      `, event.data.eventId, state.sessionId, date.getTime(), latitude, longitude, event.data.accuracyM);
    }
    await prune(db, state.sessionId);
  }));
}

export async function nextLocationBatch(sessionId: string): Promise<LocationEvent[]> {
  const rows = await useDatabase(async db => {
    await db.withTransactionAsync(() => prune(db, sessionId));
    return db.getAllAsync<Omit<LocationEvent, "capturedAt"> & { capturedAt: number }>(`
      SELECT event_id AS eventId, captured_at AS capturedAt, latitude, longitude, accuracy_m AS accuracyM
      FROM outbox WHERE session_id = ? ORDER BY captured_at, event_id LIMIT 100
    `, sessionId);
  });
  return (rows ?? []).map(row => ({ ...row, capturedAt: new Date(row.capturedAt).toISOString() }));
}

export function acknowledgeBatch(sessionId: string, eventIds: string[], rejected: number) {
  if (eventIds.length === 0) return;
  return useDatabase(db => db.withTransactionAsync(async () => {
    const parameters = eventIds.map(() => "?").join(", ");
    await db.runAsync(`DELETE FROM outbox WHERE session_id = ? AND event_id IN (${parameters})`, sessionId, ...eventIds);
    if (rejected) {
      await db.runAsync("UPDATE sharing SET dropped = dropped + ? WHERE session_id = ? AND phase = 'active'", rejected, sessionId);
    }
  }));
}
