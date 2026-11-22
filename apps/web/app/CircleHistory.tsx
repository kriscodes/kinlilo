"use client";

import {
  describeFix, hasHistoryGap, getLocalDayRange, historyLocationMarkers, buildHistoryPaths, localDateString,
  type CircleDetails, type createCircleClient,
} from "@kinlilo/contracts";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import { useLocationQuery } from "./useLocationQuery";

const CircleMap = dynamic(() => import("./CircleMap"), { ssr: false, loading: () => <p className="muted">Loading map…</p> });
type LoadHistory = ReturnType<typeof createCircleClient>["getLocationHistory"];

function HistoryPage({ circleId, memberId, from, to, cursor, load, previous, next }: {
  circleId: string; memberId: string; from: string; to: string; cursor?: string;
  load: LoadHistory; previous?: () => void; next: (cursor: string) => void;
}) {
  const loadPage = useCallback((signal: AbortSignal) => load(circleId, memberId, { from, to, cursor }, signal), [circleId, memberId, from, to, cursor, load]);
  const { data, error } = useLocationQuery(loadPage);
  const points = data?.points ?? [];
  const nextCursor = data?.nextCursor;
  return <>
    {error && <p className="error" role="status">{error}</p>}
    {!error && !data && <p className="muted" role="status">Loading history…</p>}
    {data?.status === "sharing_off" && <p className="muted">This member’s history is available while they’re sharing.</p>}
    {data?.status === "available" && !points.length && <p className="muted">No retained fixes for this selection.</p>}
    {(previous || nextCursor) && <div className="location-controls">
      {previous && <button type="button" className="outline" onClick={previous}>Earlier fixes</button>}
      {nextCursor && <button type="button" className="outline" onClick={() => next(nextCursor)}>Later fixes</button>}
    </div>}
    {points.length > 0 && <>
      <CircleMap markers={historyLocationMarkers(points)} paths={buildHistoryPaths(points)} label="Map of recorded fixes" />
      <ol className="roster history-timeline" aria-label="Recorded fixes">
        {points.map((point, index) => <li key={point.id}>
          {hasHistoryGap(points[index - 1], point) && <strong className="history-gap">Gap in reporting</strong>}
          <span>{describeFix(point)}</span>
          <small>{point.latitude.toFixed(4)}°, {point.longitude.toFixed(4)}°</small>
        </li>)}
      </ol>
    </>}
  </>;
}

export default function CircleHistory({ circle, viewerId, load }: { circle: CircleDetails; viewerId: string; load: LoadHistory }) {
  const today = localDateString(new Date());
  const [memberId, setMemberId] = useState(viewerId);
  const [date, setDate] = useState(today);
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const cursor = pages.at(-1) ?? undefined;
  const day = date <= today ? getLocalDayRange(date) : null;

  return <section aria-label="Location history">
    <h3>Location history</h3>
    <div className="history-filters">
      <label>Circle member<select value={memberId} onChange={event => { setMemberId(event.target.value); setPages([null]); }}>
        {circle.members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select></label>
      <label>Date<input type="date" value={date} max={today} onChange={event => { setDate(event.target.value); setPages([null]); }} /></label>
    </div>
    {day ? <HistoryPage key={`${memberId}/${date}/${cursor ?? ""}`} circleId={circle.id} memberId={memberId}
      from={day.from} to={day.to} cursor={cursor} load={load}
      previous={pages.length > 1 ? () => setPages(current => current.slice(0, -1)) : undefined}
      next={next => setPages(current => [...current, next])} />
      : <p className="muted">Choose a date through today.</p>}
  </section>;
}
