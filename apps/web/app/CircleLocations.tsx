"use client";

import {
  describeFix,
  hasLocationFix,
  latestLocationMarkers,
  locationStatusLabel,
  type CircleDetails,
  type createCircleClient,
} from "@kinlilo/contracts";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import CircleHistory from "./CircleHistory";
import { useLocationQuery } from "./useLocationQuery";

const CircleMap = dynamic(() => import("./CircleMap"), {
  ssr: false,
  loading: () => <p className="muted">Loading map…</p>,
});

type LocationClient = Pick<ReturnType<typeof createCircleClient>, "getLocations" | "getLocationHistory">;

export default function CircleLocations({
  circle,
  viewerId,
  api,
}: {
  circle: CircleDetails;
  viewerId: string;
  api: LocationClient;
}) {
  const [view, setView] = useState<"latest" | "history">("latest");
  return (
    <>
      <div className="location-controls location-view-buttons" role="group" aria-label="Location view">
        <button
          type="button"
          className="outline"
          aria-pressed={view === "latest"}
          onClick={() => setView("latest")}
        >
          Latest
        </button>
        <button
          type="button"
          className="outline"
          aria-pressed={view === "history"}
          onClick={() => setView("history")}
        >
          History
        </button>
      </div>
      {view === "latest" ? (
        <LatestLocations circle={circle} load={api.getLocations} />
      ) : (
        <CircleHistory circle={circle} viewerId={viewerId} load={api.getLocationHistory} />
      )}
    </>
  );
}

function LatestLocations({ circle, load }: { circle: CircleDetails; load: LocationClient["getLocations"] }) {
  const loadCircle = useCallback((signal: AbortSignal) => load(circle.id, signal), [circle.id, load]);
  const { data: locations, error, accessLost } = useLocationQuery(loadCircle);

  const members =
    locations?.members ?? circle.members.map((member) => ({ ...member, status: null, fix: null }));
  const mapped = locations?.members.filter(hasLocationFix) ?? [];
  return (
    <section aria-label="Circle locations">
      <h3>Last reported locations</h3>
      {error && (
        <p className="error" role="status">
          {error}
        </p>
      )}
      {!error && !locations && (
        <p className="muted" role="status">
          Loading locations…
        </p>
      )}
      {mapped.length > 0 && <CircleMap markers={latestLocationMarkers(mapped)} />}
      {locations && !mapped.length && <p className="muted">No locations are visible for this circle.</p>}
      {!accessLost && (
        <>
          <h3>
            Members <span className="muted">· {members.length}</span>
          </h3>
          <ul className="roster location-roster">
            {members.map((member) => (
              <li key={member.id}>
                <div>
                  <strong>{member.name}</strong>
                  <small>{member.role === "owner" ? "Owner" : "Member"}</small>
                </div>
                {member.status && (
                  <div className="location-summary">
                    <span className="location-status" data-status={member.status}>
                      {locationStatusLabel[member.status]}
                    </span>
                    {member.fix && (
                      <>
                        <small>{describeFix(member.fix)}</small>
                        <small>
                          {member.fix.latitude.toFixed(4)}°, {member.fix.longitude.toFixed(4)}°
                        </small>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
