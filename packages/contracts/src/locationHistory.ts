import { z } from "zod";
import { describeFix, fixColors, type LocationFix, type LocationMarker } from "./latestLocations";

const instant = z.iso.datetime({ precision: 3 });
const cursorParts = z.tuple([instant, z.uuid()]);
const historyCursor = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    const parts = cursorParts.safeParse(value.split("/"));
    if (!parts.success) {
      ctx.addIssue({ code: "custom", message: "Invalid history cursor." });
      return z.NEVER;
    }
    const [capturedAt, id] = parts.data;
    return { capturedAt, id };
  });

export const historyQuery = z
  .object({ from: instant, to: instant, cursor: historyCursor.optional() })
  .strict()
  .refine(({ from, to }) => {
    const duration = Date.parse(to) - Date.parse(from);
    return duration > 0 && duration <= 25 * 60 * 60_000;
  });

export type HistoryQuery = z.input<typeof historyQuery>;
export type HistoryPoint = LocationFix & { id: string; segment: string };
export type LocationHistory = {
  status: "available" | "sharing_off";
  points: HistoryPoint[];
  nextCursor: string | null;
};

export function localDateString(date: Date) {
  const two = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export function getLocalDayRange(value: string) {
  if (!z.iso.date().safeParse(value).success) return null;
  const start = new Date(value + "T00:00:00");
  if (localDateString(start) !== value) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  return { start, from: start.toISOString(), to: end.toISOString() };
}

export function hasHistoryGap(previous: HistoryPoint | undefined, point: HistoryPoint) {
  return (
    previous !== undefined &&
    (previous.segment !== point.segment ||
      Date.parse(point.capturedAt) - Date.parse(previous.capturedAt) > 10 * 60_000)
  );
}

export function buildHistoryPaths(points: HistoryPoint[]) {
  const paths: HistoryPoint[][] = [];
  let previous: HistoryPoint | undefined;
  for (const point of points) {
    if (!previous || hasHistoryGap(previous, point) || Math.abs(previous.longitude - point.longitude) > 180) {
      paths.push([]);
    }
    paths.at(-1)!.push(point);
    previous = point;
  }
  return paths.filter((path) => path.length > 1);
}

export function historyLocationMarkers(points: HistoryPoint[]): LocationMarker[] {
  return points.map((fix) => ({
    id: fix.id,
    title: "Recorded fix",
    detail: describeFix(fix),
    color: fixColors.recent,
    fix,
  }));
}
