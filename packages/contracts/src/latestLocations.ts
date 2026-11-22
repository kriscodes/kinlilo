export type LocationFix = {
  latitude: number;
  longitude: number;
  accuracyM: number;
  capturedAt: string;
};

export type FixStatus = "recent" | "delayed" | "stale";
export type MemberLocationStatus = FixStatus | "off" | "paused" | "unavailable";
export type MemberLocation = {
  id: string;
  name: string;
  role: "owner" | "member";
} & (
  | { status: FixStatus; fix: LocationFix }
  | { status: "off" | "paused" | "unavailable"; fix: null }
);
export type CircleLocations = { members: MemberLocation[] };
export type MappedMember = Extract<MemberLocation, { fix: LocationFix }>;

export const locationPollIntervalMs = 15_000;

export function createLocationPoller<T>(
  load: (signal: AbortSignal) => Promise<T>,
  onLocations: (locations: T) => void,
  onError: (error: unknown) => void,
) {
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function stop() {
    clearTimeout(timer);
    clearTimeout(deadline);
    const previous = request;
    request = undefined;
    previous?.abort();
  }

  function refresh() {
    stop();
    const controller = new AbortController();
    request = controller;
    deadline = setTimeout(() => {
      stop();
      onError(new Error("Could not refresh locations in time."));
      timer = setTimeout(refresh, locationPollIntervalMs);
    }, 10_000);
    void load(controller.signal).then(locations => {
      if (request === controller) onLocations(locations);
    }).catch(error => {
      if (request === controller) onError(error);
    }).finally(() => {
      if (request !== controller) return;
      request = undefined;
      clearTimeout(deadline);
      timer = setTimeout(refresh, locationPollIntervalMs);
    });
  }

  return { refresh, stop };
}

export const locationStatusLabel: Record<MemberLocationStatus, string> = {
  recent: "Recent fix",
  delayed: "Delayed fix",
  stale: "Stale fix",
  off: "Sharing off",
  paused: "Sharing paused",
  unavailable: "Location unavailable",
};

export const fixColors: Record<FixStatus, string> = { recent: "#563b72", delayed: "#805218", stale: "#625b70" };

export function getFixStatus(capturedAtMs: number, nowMs: number): FixStatus {
  const ageMs = nowMs - capturedAtMs;
  if (ageMs <= 2 * 60_000) return "recent";
  return ageMs <= 15 * 60_000 ? "delayed" : "stale";
}

export function hasLocationFix(member: MemberLocation): member is MappedMember {
  return member.fix !== null;
}

export function describeFix(fix: LocationFix) {
  return `Captured ${new Date(fix.capturedAt).toLocaleString()} · Accuracy ±${Math.ceil(fix.accuracyM)} m`;
}

export type LocationMarker = { id: string; title: string; detail: string; color: string; fix: LocationFix };

export function latestLocationMarkers(members: readonly MappedMember[]): LocationMarker[] {
  return members.map(({ id, name, status, fix }) => ({
    id, title: name, detail: `${locationStatusLabel[status]} · ${describeFix(fix)}`, color: fixColors[status], fix,
  }));
}

export function locationBounds(members: readonly { fix: LocationFix }[]) {
  const longitudes = members.map(member => member.fix.longitude).sort((a, b) => a - b);
  const latitudes = members.map(member => member.fix.latitude);
  let west = longitudes[0];
  let east = longitudes.at(-1)!;
  let largestGap = west + 360 - east;
  // Exclude the widest empty stretch so homes on either side of the date line stay in view.
  for (let i = 1; i < longitudes.length; i++) {
    const gap = longitudes[i] - longitudes[i - 1];
    if (gap > largestGap) {
      largestGap = gap;
      west = longitudes[i];
      east = longitudes[i - 1] + 360;
    }
  }
  return { west, east, south: Math.min(...latitudes), north: Math.max(...latitudes) };
}
