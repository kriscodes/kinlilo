"use client";

import { describeFix, fixColors, locationBounds, locationStatusLabel, type MappedMember } from "@kinlilo/contracts";
import { Map as MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";

const localStyle: StyleSpecification = {
  version: 8,
  sources: { land: { type: "geojson", data: "/maps/land.geojson", attribution: "Natural Earth" } },
  layers: [
    { id: "water", type: "background", paint: { "background-color": "#e3edf4" } },
    { id: "land", type: "fill", source: "land", paint: { "fill-color": "#eee7dc", "fill-outline-color": "#c7beb1" } },
  ],
};
const style = process.env.NEXT_PUBLIC_KINLILO_MAP_STYLE_URL || localStyle;

function fitLocations(map: MapLibreMap, members: MappedMember[], duration: number) {
  const { west, east, south, north } = locationBounds(members);
  const clamp = (latitude: number) => Math.min(85.05, Math.max(-85.05, latitude));
  map.fitBounds([[west, clamp(south)], [east, clamp(north)]], { padding: 42, maxZoom: typeof style === "string" ? 14 : 6, duration });
}

export default function CircleMap({ members }: { members: MappedMember[] }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, { marker: Marker; element: HTMLButtonElement; popup: Popup }>());
  const fitted = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    let instance: MapLibreMap;
    try {
      setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString());
      instance = new MapLibreMap({ container: container.current, style, center: [0, 0], zoom: 1, scrollZoom: false });
      instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    } catch {
      setFailed(true);
      return;
    }
    map.current = instance;
    instance.once("error", () => setFailed(true));
    const pins = markers.current;
    return () => {
      fitted.current = false;
      map.current = null;
      pins.forEach(({ marker }) => marker.remove());
      pins.clear();
      instance.remove();
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance || failed || !members.length) return;
    const pins = markers.current;
    const visibleIds = new Set(members.map(member => member.id));
    for (const [id, { marker }] of pins) {
      if (visibleIds.has(id)) continue;
      marker.remove();
      pins.delete(id);
    }
    for (const member of members) {
      const coordinates: [number, number] = [member.fix.longitude, member.fix.latitude];
      let pin = pins.get(member.id);
      if (!pin) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "location-map-marker";
        const popup = new Popup({ offset: 12, maxWidth: "210px" });
        const marker = new Marker({ element }).setLngLat(coordinates).setPopup(popup).addTo(instance);
        pin = { marker, element, popup };
        pins.set(member.id, pin);
      }
      const label = `${member.name} · ${locationStatusLabel[member.status]} · ${describeFix(member.fix)}`;
      pin.marker.setLngLat(coordinates);
      pin.element.setAttribute("aria-label", label);
      pin.element.style.setProperty("--pin-color", fixColors[member.status]);
      pin.popup.setText(label);
    }
    if (!fitted.current) {
      fitLocations(instance, members, 0);
      fitted.current = true;
    }
  }, [members, failed]);

  return <>
    <div ref={container} className="circle-map" aria-label="Map of last reported locations" hidden={failed} />
    {failed ? <p className="muted">Map unavailable. Location details are listed below.</p>
      : <button type="button" className="outline fit-locations" onClick={() => { if (map.current) fitLocations(map.current, members, 250); }}>Fit locations</button>}
  </>;
}
