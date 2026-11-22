import { ApiError, createLocationPoller } from "@kinlilo/contracts";
import * as Network from "expo-network";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

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
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") poller.refresh();
      else {
        poller.stop();
        setData(null);
      }
    });
    const network = Network.addNetworkStateListener((state) => {
      if (state.isConnected && AppState.currentState === "active") poller.refresh();
      if (state.isConnected === false) {
        poller.stop();
        setData(null);
        setError("You’re offline. Reconnect to see locations.");
      }
    });
    if (AppState.currentState === "active") poller.refresh();
    return () => {
      poller.stop();
      appState.remove();
      network.remove();
    };
  }, [load]);

  return { data, error, accessLost };
}
