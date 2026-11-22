import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";

export const locationHarnessEnabled = Platform.OS === "ios"
  && process.env.EXPO_PUBLIC_KINLILO_LOCATION_HARNESS === "1"
  && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

const taskName = "kinlilo.location-harness";
const queueLimit = 1_000;
const probeValue = "kinlilo-location-harness-test-value";
const afterFirstUnlock = {
  key: "kinlilo.location-harness.after-first-unlock",
  options: { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
};
const whileUnlocked = {
  key: "kinlilo.location-harness.while-unlocked",
  options: { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
};

type ProbeResult = "readable" | "missing" | "unavailable";
type Diagnostic = {
  event_id: string;
  received_at: number;
  first_fix_at: number | null;
  last_fix_at: number | null;
  sample_count: number;
  app_state: string;
  after_first_unlock: ProbeResult;
  while_unlocked: ProbeResult;
  task_error: 0 | 1;
};

let database: Promise<SQLite.SQLiteDatabase> | undefined;

async function openDatabase() {
  const db = await SQLite.openDatabaseAsync("kinlilo-location-harness.db");
  try {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS harness_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        started_at INTEGER
      );
      INSERT OR IGNORE INTO harness_state (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS diagnostics (
        event_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        first_fix_at INTEGER,
        last_fix_at INTEGER,
        sample_count INTEGER NOT NULL,
        app_state TEXT NOT NULL,
        after_first_unlock TEXT NOT NULL,
        while_unlocked TEXT NOT NULL,
        task_error INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS diagnostics_recent ON diagnostics (received_at DESC, event_id DESC);
      CREATE TRIGGER IF NOT EXISTS limit_diagnostics AFTER INSERT ON diagnostics BEGIN
        DELETE FROM diagnostics WHERE event_id IN (
          SELECT event_id FROM diagnostics ORDER BY received_at DESC, event_id DESC LIMIT -1 OFFSET ${queueLimit}
        );
      END;
    `);
    return db;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

function getDatabase() {
  database ??= openDatabase().catch(error => {
    database = undefined;
    throw error;
  });
  return database;
}

async function readProbe({ key, options }: typeof afterFirstUnlock): Promise<ProbeResult> {
  try {
    return await SecureStore.getItemAsync(key, options) === probeValue ? "readable" : "missing";
  } catch {
    return "unavailable";
  }
}

if (locationHarnessEnabled) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(taskName, async ({ data, error, executionInfo }) => {
    const receivedAt = Date.now();
    const appState = AppState.currentState ?? "unknown";
    try {
      const db = await getDatabase();
      const state = await db.getFirstAsync<{ started_at: number | null }>("SELECT started_at FROM harness_state WHERE id = 1");
      const startedAt = state?.started_at ?? null;
      if (startedAt === null) return;

      const timestamps = (data?.locations ?? []).map(fix => fix.timestamp)
        .filter(timestamp => Number.isFinite(timestamp) && timestamp >= startedAt);
      if (!error && timestamps.length === 0) return;

      const [afterFirstUnlockResult, whileUnlockedResult] = await Promise.all([
        readProbe(afterFirstUnlock),
        readProbe(whileUnlocked),
      ]);
      const firstFix = timestamps.length ? Math.min(...timestamps) : null;
      const lastFix = timestamps.length ? Math.max(...timestamps) : null;

      // The test may have stopped or restarted while the Keychain probes were running.
      await db.runAsync(`
        INSERT OR IGNORE INTO diagnostics (
          event_id, received_at, first_fix_at, last_fix_at, sample_count, app_state,
          after_first_unlock, while_unlocked, task_error
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT started_at FROM harness_state WHERE id = 1) = ?
      `, executionInfo.eventId, receivedAt, firstFix, lastFix, timestamps.length, appState,
      afterFirstUnlockResult, whileUnlockedResult, error ? 1 : 0, startedAt);
    } catch {
      console.warn("Kinlilo could not save a location harness diagnostic.");
    }
  });
}

export async function getLocationHarnessStatus() {
  const [foreground, background, registered, db] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    Location.hasStartedLocationUpdatesAsync(taskName),
    getDatabase(),
  ]);
  const state = await db.getFirstAsync<{ started_at: number | null; queued: number }>(`
    SELECT started_at, (SELECT COUNT(*) FROM diagnostics) AS queued FROM harness_state WHERE id = 1
  `);
  const latest = await db.getFirstAsync<Diagnostic>("SELECT * FROM diagnostics ORDER BY received_at DESC, event_id DESC LIMIT 1");
  return { foreground, background, registered, startedAt: state?.started_at ?? null, queued: state?.queued ?? 0, latest };
}

export async function startLocationHarness() {
  if (!locationHarnessEnabled || !await TaskManager.isAvailableAsync()) {
    throw new Error("Open a native iOS build with the location test enabled.");
  }
  const state = await getLocationHarnessStatus();
  if (!state.foreground.granted || !state.background.granted) {
    throw new Error("Allow location Always in Settings before starting the test.");
  }
  if (!await Location.hasServicesEnabledAsync()) throw new Error("Turn on Location Services before starting the test.");
  if (state.startedAt !== null || state.registered) throw new Error("Stop the existing test before starting again.");

  const db = await getDatabase();
  await Promise.all([afterFirstUnlock, whileUnlocked].map(({ key, options }) => SecureStore.setItemAsync(key, probeValue, options)));
  await db.runAsync("UPDATE harness_state SET started_at = ? WHERE id = 1", Date.now());
  try {
    await Location.startLocationUpdatesAsync(taskName, {
      accuracy: Location.Accuracy.High,
      distanceInterval: 50,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });
  } catch (error) {
    await db.runAsync("UPDATE harness_state SET started_at = NULL WHERE id = 1");
    throw error;
  }
}

export async function stopLocationHarness() {
  try {
    const db = await getDatabase();
    await db.runAsync("UPDATE harness_state SET started_at = NULL WHERE id = 1");
  } finally {
    if (await Location.hasStartedLocationUpdatesAsync(taskName)) await Location.stopLocationUpdatesAsync(taskName);
  }
}

export async function clearLocationDiagnostics() {
  const db = await getDatabase();
  await db.runAsync("DELETE FROM diagnostics WHERE (SELECT started_at FROM harness_state WHERE id = 1) IS NULL");
}

export async function getLocationDiagnosticReport() {
  const db = await getDatabase();
  const callbacks = await db.getAllAsync<Omit<Diagnostic, "event_id">>(`
    SELECT received_at, first_fix_at, last_fix_at, sample_count, app_state, after_first_unlock, while_unlocked, task_error
    FROM diagnostics ORDER BY received_at, event_id
  `);
  return JSON.stringify({ timestampUnit: "unix milliseconds", queueLimit, callbacks }, null, 2);
}
