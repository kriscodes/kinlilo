import { z } from "zod";
import type { CircleLocations } from "./latestLocations";

export * from "./latestLocations";

export const circleId = z.uuid();
export const createCircle = z.object({ name: z.string().trim().min(1).max(60) }).strict();
export const acceptInvite = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export const deviceId = z.uuid();
export const trackingSessionId = z.uuid();
export const registerDevice = z.object({
  installationId: z.uuid(),
  label: z.string().trim().min(1).max(60),
}).strict();
export const startSharing = z.object({ deviceId, version: z.uuid() }).strict();
export const locationEvent = z.object({
  eventId: z.uuid(),
  capturedAt: z.iso.datetime({ precision: 3 }),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().nonnegative(),
}).strict();
export const locationBatch = z.object({
  sessionId: trackingSessionId,
  events: z.array(locationEvent).min(1).max(100),
}).strict();

export type CircleRole = "owner" | "member";
export type Circle = {
  id: string;
  name: string;
  role: CircleRole;
  memberCount: number;
};
export type CircleMember = { id: string; name: string; role: CircleRole };
export type CircleDetails = Circle & { members: CircleMember[] };
export type CircleInvite = { code: string; expiresAt: string };
export type Device = { id: string; label: string; registeredAt: string; revokedAt: string | null };
export type TrackingSession = { id: string; deviceId: string; startedAt: string };
export type CircleSharing = { version: string; activeSession: TrackingSession | null };
export type LocationEvent = z.infer<typeof locationEvent>;
export type LocationBatchEventResult =
  | { eventId: string; status: "accepted" | "duplicate" }
  | { eventId: string; status: "rejected"; reason: "before_session" | "future_timestamp" | "event_conflict" };
export type LocationBatchResult = { serverTime: string; results: LocationBatchEventResult[] };

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type RequestOptions = {
  baseUrl: string;
  credentials?: RequestCredentials;
  headers?: () => HeadersInit | Promise<HeadersInit>;
};

export function createCircleClient({ baseUrl, credentials, headers }: RequestOptions) {
  async function request<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
    const requestHeaders = new Headers(await headers?.());
    if (body) requestHeaders.set("Content-Type", "application/json");
    const response = await fetch(baseUrl + "/v1" + path, {
      method,
      credentials,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(response.status, result?.error?.message ?? "Unable to connect to Kinlilo. Try again.");
    }
    return result as T;
  }

  return {
    list: () => request<{ circles: Circle[] }>("/circles"),
    get: (id: string) => request<CircleDetails>("/circles/" + encodeURIComponent(id)),
    getLocations: (id: string, signal?: AbortSignal) =>
      request<CircleLocations>("/circles/" + encodeURIComponent(id) + "/locations", "GET", undefined, signal),
    create: (name: string) => request<Circle>("/circles", "POST", { name }),
    invite: (id: string) => request<CircleInvite>(
      "/circles/" + encodeURIComponent(id) + "/invites", "POST", {},
    ),
    join: (code: string) => request<Circle>("/circles/join", "POST", { code }),
    leave: (id: string) => request<{ ok: true }>(
      "/circles/" + encodeURIComponent(id) + "/leave", "POST", {},
    ),
    listDevices: () => request<{ devices: Device[] }>("/devices"),
    registerDevice: (input: z.input<typeof registerDevice>) => request<Device>("/devices", "POST", input),
    revokeDevice: (id: string) => request<Device>("/devices/" + encodeURIComponent(id) + "/revoke", "POST", {}),
    getSharing: (id: string) => request<CircleSharing>("/circles/" + encodeURIComponent(id) + "/sharing"),
    startSharing: (id: string, input: z.input<typeof startSharing>) => request<CircleSharing>(
      "/circles/" + encodeURIComponent(id) + "/tracking-sessions", "POST", input,
    ),
    pauseSharing: (id: string, sessionId: string, signal?: AbortSignal) => request<CircleSharing>(
      "/circles/" + encodeURIComponent(id) + "/tracking-sessions/" + encodeURIComponent(sessionId) + "/pause", "POST", {}, signal,
    ),
    uploadLocationBatch: (input: z.input<typeof locationBatch>, signal?: AbortSignal) =>
      request<LocationBatchResult>("/location-batches", "POST", input, signal),
  };
}
