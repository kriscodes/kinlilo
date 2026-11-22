"use client";

import {
  ApiError, createLocationPoller, describeFix, hasLocationFix, locationStatusLabel,
  type CircleDetails, type CircleLocations as LocationResponse,
} from "@kinlilo/contracts";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const CircleMap = dynamic(() => import("./CircleMap"), { ssr: false, loading: () => <p className="muted">Loading map…</p> });

export default function CircleLocations({ circle, load }: {
  circle: CircleDetails;
  load: (id: string, signal: AbortSignal) => Promise<LocationResponse>;
}) {
  const [locations, setLocations] = useState<LocationResponse | null>(null);
  const [error, setError] = useState("");
  const [accessLost, setAccessLost] = useState(false);

  useEffect(() => {
    const poller = createLocationPoller(signal => load(circle.id, signal), result => {
      setLocations(result);
      setAccessLost(false);
      setError("");
    }, failure => {
      const hidden = failure instanceof ApiError && (failure.status === 401 || failure.status === 404);
      setLocations(null);
      setAccessLost(hidden);
      setError(hidden ? "This circle’s locations are no longer available to you." : "Could not refresh locations.");
    });
    function update() {
      if (document.visibilityState === "visible" && navigator.onLine) poller.refresh();
      else {
        poller.stop();
        setLocations(null);
        if (!navigator.onLine) setError("You’re offline. Reconnect to see locations.");
      }
    }
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      poller.stop();
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [circle.id, load]);

  const members = locations?.members ?? circle.members.map(member => ({ ...member, status: null, fix: null }));
  const mapped = locations?.members.filter(hasLocationFix) ?? [];
  return <section aria-label="Circle locations">
    <h3>Last reported locations</h3>
    {error && <p className="error" role="status">{error}</p>}
    {!error && !locations && <p className="muted" role="status">Loading locations…</p>}
    {mapped.length > 0 && <CircleMap members={mapped} />}
    {locations && !mapped.length && <p className="muted">No locations are visible for this circle.</p>}
    {!accessLost && <>
      <h3>Members <span className="muted">· {members.length}</span></h3>
      <ul className="roster location-roster">{members.map(member => <li key={member.id}>
        <div><strong>{member.name}</strong><small>{member.role === "owner" ? "Owner" : "Member"}</small></div>
        {member.status && <div className="location-summary">
          <span className="location-status" data-status={member.status}>{locationStatusLabel[member.status]}</span>
          {member.fix && <>
            <small>{describeFix(member.fix)}</small>
            <small>{member.fix.latitude.toFixed(4)}°, {member.fix.longitude.toFixed(4)}°</small>
          </>}
        </div>}
      </li>)}</ul>
    </>}
  </section>;
}
