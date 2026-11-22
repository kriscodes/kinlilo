import { ApiError, type LocationBatchResult, type LocationEvent } from "@kinlilo/contracts";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Location from "expo-location";
import * as Network from "expo-network";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";
import { api, supportsLocationUploads } from "./mobileApi";
import {
  acknowledgeBatch,
  activateOutbox,
  enqueueLocations,
  getInstallationId,
  getOutboxStatus,
  nextLocationBatch,
  pauseOutbox,
  removeOutbox,
  type SharingStatus,
} from "./locationOutbox";

export const locationSharingAvailable =
  Platform.OS === "ios" && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
const taskName = "kinlilo.location-sharing";
const initialRetryMs = 2_000;
const maximumRetryMs = 60_000;
let retryDelayMs = initialRetryMs;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let activeSyncController: AbortController | undefined;
let syncRequested = false;
let signedInAccountId: string | null | undefined;
let sharingActionQueue: Promise<unknown> = Promise.resolve();
let sharingActionsPending = 0;

let snapshot: { state: SharingStatus | null; error: string | null } = { state: null, error: null };
const listeners = new Set<() => void>();
export function getSharingSnapshot() {
  return snapshot;
}
export function subscribeToSharing(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function publishStatus() {
  try {
    snapshot = { state: await getOutboxStatus(), error: null };
  } catch {
    snapshot = { ...snapshot, error: "Encrypted location storage is unavailable." };
  }
  listeners.forEach((listener) => listener());
}

async function stopCapture() {
  if (await Location.hasStartedLocationUpdatesAsync(taskName))
    await Location.stopLocationUpdatesAsync(taskName);
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
}

function queueSharingAction<T>(action: () => Promise<T>) {
  sharingActionsPending++;
  activeSyncController?.abort();
  const next = sharingActionQueue.then(action);
  sharingActionQueue = next.catch(() => {});
  return next.finally(async () => {
    sharingActionsPending--;
    await publishStatus();
    requestSync(true);
  });
}

export function startLocationSharing(accountId: string, circleId: string) {
  return queueSharingAction(async () => {
    if (!locationSharingAvailable || !(await TaskManager.isAvailableAsync()))
      throw new Error("Use a native iOS build to share location.");
    if (!supportsLocationUploads()) throw new Error("Configure an HTTPS API URL before sharing location.");
    if (await getOutboxStatus())
      throw new Error("Pause sharing from this iPhone before starting another session.");
    const installationId = await getInstallationId();
    if (!(await Location.hasServicesEnabledAsync()))
      throw new Error("Turn on Location Services before sharing.");
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) throw new Error("Allow location access in iOS Settings before sharing.");
    const background = await Location.requestBackgroundPermissionsAsync();
    if (!background.granted) throw new Error("Set Kinlilo’s location permission to Always in iOS Settings.");
    if (signedInAccountId !== accountId) throw new Error("Sign in again before sharing.");

    const current = await api.getSharing(circleId);
    const device = await api.registerDevice({ installationId, label: "iPhone" });
    const { activeSession } = await api.startSharing(circleId, {
      deviceId: device.id,
      version: current.version,
    });
    if (!activeSession) throw new Error("Kinlilo could not start sharing.");
    const { id: sessionId, startedAt } = activeSession;
    try {
      await activateOutbox({
        accountId,
        circleId,
        sessionId,
        captureAfter: Math.max(Date.now(), Date.parse(startedAt)),
      });
    } catch (error) {
      if (signedInAccountId === accountId) await api.pauseSharing(circleId, sessionId).catch(() => {});
      throw error;
    }
    try {
      if (signedInAccountId !== accountId) throw new Error("Sign in again before sharing.");
      await Location.startLocationUpdatesAsync(taskName, {
        accuracy: Location.Accuracy.High,
        distanceInterval: 50,
        pausesUpdatesAutomatically: true,
        showsBackgroundLocationIndicator: true,
      });
    } catch (error) {
      try {
        await pauseOutbox(sessionId);
      } finally {
        await stopCapture();
      }
      throw error;
    }
  });
}

type SharingTarget = { accountId?: string; circleId?: string; sessionId?: string };

async function pauseOnDevice(target?: SharingTarget) {
  const state = await getOutboxStatus();
  if (
    !state ||
    (target?.accountId && target.accountId !== state.accountId) ||
    (target?.circleId && target.circleId !== state.circleId) ||
    (target?.sessionId && target.sessionId !== state.sessionId)
  )
    return;
  try {
    await pauseOutbox(state.sessionId);
  } finally {
    await stopCapture();
  }
  return state;
}

export function pauseLocationSharing(target?: SharingTarget) {
  return queueSharingAction(() => pauseOnDevice(target));
}

async function confirmPause(local: SharingStatus, signal: AbortSignal) {
  try {
    const state = await api.pauseSharing(local.circleId, local.sessionId, signal);
    if (!state?.version || state.activeSession?.id === local.sessionId)
      throw new Error("Pause was not confirmed.");
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  if (!signal.aborted) await removeOutbox(local.sessionId);
}

export function pauseBeforeSigningOut(accountId: string) {
  if (!locationSharingAvailable) return;
  return queueSharingAction(async () => {
    const local = await pauseOnDevice({ accountId });
    if (!local || (await Network.getNetworkStateAsync()).isConnected === false) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      await confirmPause(local, controller.signal);
    } catch {
      /* Keep the pause pending for the next authenticated connection. */
    } finally {
      clearTimeout(timeout);
    }
  });
}

function validateBatchReceipt(events: LocationEvent[], receipt: LocationBatchResult) {
  const remaining = new Set(events.map((event) => event.eventId));
  const eventIds: string[] = [];
  let rejected = 0;
  if (!Array.isArray(receipt?.results) || receipt.results.length !== remaining.size)
    throw new Error("Incomplete location receipt.");
  for (const result of receipt.results) {
    if (!remaining.delete(result?.eventId)) throw new Error("Unexpected location receipt.");
    if (result.status === "rejected") {
      if (!["before_session", "future_timestamp", "event_conflict"].includes(result.reason))
        throw new Error("Unexpected location rejection.");
      rejected++;
    } else if (result.status !== "accepted" && result.status !== "duplicate") {
      throw new Error("Unexpected location receipt.");
    }
    eventIds.push(result.eventId);
  }
  return { eventIds, rejected };
}

async function syncSharing(accountId: string, signal: AbortSignal) {
  const local = await getOutboxStatus();
  if (!local || local.accountId !== accountId || signal.aborted) return;
  if (local.phase === "pausing") {
    // A restart can occur after the durable pause and before native capture was stopped.
    await stopCapture();
  } else {
    const permission = await Location.getBackgroundPermissionsAsync();
    if (signal.aborted) return;
    if (!permission.granted) {
      await pauseLocationSharing({ sessionId: local.sessionId });
      return;
    }
  }
  const network = await Network.getNetworkStateAsync();
  if (network.isConnected === false || signal.aborted) return;

  if (local.phase === "pausing") {
    await confirmPause(local, signal);
    return;
  }
  if (!supportsLocationUploads()) return;

  while (!signal.aborted && AppState.currentState === "active") {
    const events = await nextLocationBatch(local.sessionId);
    if (events.length === 0 || signal.aborted) return;
    let receipt: LocationBatchResult;
    try {
      receipt = await api.uploadLocationBatch({ sessionId: local.sessionId, events }, signal);
    } catch (error) {
      if (signal.aborted || !(error instanceof ApiError && error.status === 404)) throw error;
      await queueSharingAction(async () => {
        const current = await getOutboxStatus();
        if (current?.sessionId !== local.sessionId) return;
        await pauseOutbox(local.sessionId);
        await stopCapture();
        await removeOutbox(local.sessionId);
      });
      return;
    }
    if (signal.aborted) return;
    const { eventIds, rejected } = validateBatchReceipt(events, receipt);
    await acknowledgeBatch(local.sessionId, eventIds, rejected);
  }
}

function requestSync(immediate = false) {
  // The current account session is used only while the app is active. The iOS task only queues fixes.
  if (immediate) clearRetry();
  if (
    !locationSharingAvailable ||
    !signedInAccountId ||
    AppState.currentState !== "active" ||
    sharingActionsPending ||
    retryTimer
  )
    return;
  if (activeSyncController) {
    syncRequested = true;
    return;
  }
  const controller = new AbortController();
  activeSyncController = controller;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  function scheduleRetry(error?: unknown) {
    const delay = error instanceof ApiError && error.status === 429 ? maximumRetryMs : retryDelayMs;
    retryDelayMs = Math.min(maximumRetryMs, retryDelayMs * 2);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      requestSync();
    }, delay);
  }
  void syncSharing(signedInAccountId, controller.signal)
    .then(() => {
      if (timedOut) scheduleRetry();
      else if (!controller.signal.aborted) retryDelayMs = initialRetryMs;
    })
    .catch((error) => {
      if (timedOut || !controller.signal.aborted) scheduleRetry(error);
    })
    .finally(async () => {
      clearTimeout(deadline);
      activeSyncController = undefined;
      await publishStatus();
      if (syncRequested) {
        syncRequested = false;
        requestSync();
      }
    });
}

export function setSharingAccount(accountId: string | null | undefined) {
  if (!locationSharingAvailable || signedInAccountId === accountId) return;
  signedInAccountId = accountId;
  activeSyncController?.abort();
  if (accountId !== undefined) {
    void getOutboxStatus()
      .then((state) => {
        if (signedInAccountId === accountId && state?.phase === "active" && state.accountId !== accountId) {
          return pauseLocationSharing({ sessionId: state.sessionId });
        }
      })
      .catch(() => {});
  }
  requestSync(true);
}

export function watchLocationSharing() {
  if (!locationSharingAvailable) return;
  void publishStatus()
    .then(() => {
      if (snapshot.state?.phase === "pausing") return stopCapture();
    })
    .catch(() => {});
  const foreground = AppState.addEventListener("change", (state) => {
    if (state === "active") {
      void publishStatus();
      requestSync(true);
    } else {
      clearRetry();
      activeSyncController?.abort();
    }
  });
  const network = Network.addNetworkStateListener((state) => {
    if (state.isConnected) requestSync(true);
    else if (state.isConnected === false) activeSyncController?.abort();
  });
  return () => {
    foreground.remove();
    network.remove();
    clearRetry();
    activeSyncController?.abort();
  };
}

if (locationSharingAvailable) {
  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(taskName, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    try {
      await enqueueLocations(data.locations);
      if (AppState.currentState === "active") {
        await publishStatus();
        requestSync();
      }
    } catch {
      // Native and database errors can include a sample or an encryption key.
      console.warn("Kinlilo could not queue a location update.");
    }
  });
}
