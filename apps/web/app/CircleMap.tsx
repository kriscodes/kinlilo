"use client";

import { locationBounds, type LocationFix, type LocationMarker } from "@kinlilo/contracts";
import { Map as MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
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

function fitLocations(map: MapLibreMap, markers: LocationMarker[], maxZoom: number, duration: number) {
  const { west, east, south, north } = locationBounds(markers);
  const clamp = (latitude: number) => Math.min(85.05, Math.max(-85.05, latitude));
  map.fitBounds([[west, clamp(south)], [east, clamp(north)]], { padding: 42, maxZoom, duration });
}

export default function CircleMap({ markers, paths, label = "Map of last reported locations" }: {
  markers: LocationMarker[]; paths?: LocationFix[][]; label?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const livePins = useRef(new Map<string, { marker: Marker; element: HTMLButtonElement; popup: Popup }>());
  const fitted = useRef(false);
  const [failed, setFailed] = useState(false);
  const maxZoom = paths || typeof style === "string" ? 14 : 6;

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
    const pins = livePins.current;
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
    if (!instance || failed || !markers.length) return;
    const pins = livePins.current;
    const visibleIds = new Set(markers.map(marker => marker.id));
    for (const [id, { marker }] of pins) {
      if (visibleIds.has(id)) continue;
      marker.remove();
      pins.delete(id);
    }
    for (const marker of markers) {
      const coordinates: [number, number] = [marker.fix.longitude, marker.fix.latitude];
      let pin = pins.get(marker.id);
      if (!pin) {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "location-map-marker";
        const popup = new Popup({ offset: 12, maxWidth: "210px" });
        pin = { marker: new Marker({ element }).setLngLat(coordinates).setPopup(popup).addTo(instance), element, popup };
        pins.set(marker.id, pin);
      }
      const label = `${marker.title} · ${marker.detail}`;
      pin.marker.setLngLat(coordinates);
      pin.element.setAttribute("aria-label", label);
      pin.element.style.setProperty("--pin-color", marker.color);
      pin.popup.setText(label);
    }
    if (!fitted.current) {
      fitLocations(instance, markers, maxZoom, 0);
      fitted.current = true;
    }
  }, [markers, maxZoom, failed]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || failed || !paths) return;
    const data = {
      type: "FeatureCollection" as const,
      features: paths.map(path => ({
        type: "Feature" as const, properties: {},
        geometry: { type: "LineString" as const, coordinates: path.map(fix => [fix.longitude, fix.latitude]) },
      })),
    };
    const sourceId = "kinlilo-history-paths";
    function draw() {
      if (!instance) return;
      const source = instance.getSource<GeoJSONSource>(sourceId);
      if (source) { source.setData(data); return; }
      instance.addSource(sourceId, { type: "geojson", data });
      instance.addLayer({ id: sourceId, type: "line", source: sourceId, paint: {
        "line-color": "#563b72", "line-width": 3, "line-dasharray": [2, 2],
      } });
    }
    if (instance.getSource(sourceId) || instance.isStyleLoaded()) draw();
    else instance.once("load", draw);
    return () => { instance.off("load", draw); };
  }, [paths, failed]);

  return <>
    <div ref={container} className="circle-map" aria-label={label} hidden={failed} />
    {failed ? <p className="muted">Map unavailable. Location details are listed below.</p>
      : <button type="button" className="outline fit-locations" onClick={() => { if (map.current) fitLocations(map.current, markers, maxZoom, 250); }}>Fit locations</button>}
  </>;
}
