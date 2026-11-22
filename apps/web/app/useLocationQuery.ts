"use client";

import { ApiError, createLocationPoller } from "@kinlilo/contracts";
import { useEffect, useState } from "react";

export function useLocationQuery<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [accessLost, setAccessLost] = useState(false);

  useEffect(() => {
    const poller = createLocationPoller(
      load,
      (result) => {
        setData(result);
        setAccessLost(false);
        setError("");
      },
      (failure) => {
        const hidden = failure instanceof ApiError && (failure.status === 401 || failure.status === 404);
        setData(null);
        setAccessLost(hidden);
        setError(hidden ? "These locations are no longer available to you." : "Could not refresh locations.");
      },
    );
    function update() {
      if (document.visibilityState === "visible" && navigator.onLine) poller.refresh();
      else {
        poller.stop();
        setData(null);
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
  }, [load]);

  return { data, error, accessLost };
}
