import {
  ApiError, createLocationPoller, describeFix, fixColors, hasLocationFix, locationBounds, locationStatusLabel,
  type CircleDetails, type CircleLocations as LocationResponse, type MappedMember,
} from "@kinlilo/contracts";
import * as Network from "expo-network";
import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, type Region } from "react-native-maps";
import { api } from "./mobileApi";

function regionFor(members: MappedMember[]): Region {
  const { west, east, south, north } = locationBounds(members);
  return {
    latitude: Math.max(-89, Math.min(89, (south + north) / 2)),
    longitude: ((west + east) / 2 + 540) % 360 - 180,
    latitudeDelta: Math.min(179, Math.max(.02, (north - south) * 1.5)),
    longitudeDelta: Math.min(359, Math.max(.02, (east - west) * 1.5)),
  };
}

function CircleMap({ members }: { members: MappedMember[] }) {
  const map = useRef<MapView>(null);
  return <>
    <MapView ref={map} initialRegion={regionFor(members)} style={styles.map} userInterfaceStyle="light"
      accessibilityLabel="Map of last reported locations">
      {members.map(member => <Marker key={member.id} title={member.name} pinColor={fixColors[member.status]}
        coordinate={{ latitude: member.fix.latitude, longitude: member.fix.longitude }}
        description={`${locationStatusLabel[member.status]} · ${describeFix(member.fix)}`} />)}
    </MapView>
    <Pressable accessibilityRole="button" style={styles.fit} onPress={() => map.current?.animateToRegion(regionFor(members), 250)}>
      <Text style={styles.fitText}>Fit locations</Text>
    </Pressable>
  </>;
}

export default function CircleLocations({ circle }: { circle: CircleDetails }) {
  const [locations, setLocations] = useState<LocationResponse | null>(null);
  const [error, setError] = useState("");
  const [accessLost, setAccessLost] = useState(false);

  useEffect(() => {
    const poller = createLocationPoller(signal => api.getLocations(circle.id, signal), result => {
      setLocations(result);
      setAccessLost(false);
      setError("");
    }, failure => {
      const hidden = failure instanceof ApiError && (failure.status === 401 || failure.status === 404);
      setLocations(null);
      setAccessLost(hidden);
      setError(hidden ? "This circle’s locations are no longer available to you." : "Could not refresh locations.");
    });
    const appState = AppState.addEventListener("change", state => {
      if (state === "active") poller.refresh();
      else { poller.stop(); setLocations(null); }
    });
    const network = Network.addNetworkStateListener(state => {
      if (state.isConnected && AppState.currentState === "active") poller.refresh();
      if (state.isConnected === false) {
        poller.stop();
        setLocations(null);
        setError("You’re offline. Reconnect to see locations.");
      }
    });
    if (AppState.currentState === "active") poller.refresh();
    return () => { poller.stop(); appState.remove(); network.remove(); };
  }, [circle.id]);

  const members = locations?.members ?? circle.members.map(member => ({ ...member, status: null, fix: null }));
  const mapped = locations?.members.filter(hasLocationFix) ?? [];
  return <>
    <Text accessibilityRole="header" style={styles.label}>Last reported locations</Text>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!error && !locations && <Text style={styles.muted}>Loading locations…</Text>}
    {mapped.length > 0 && <CircleMap members={mapped} />}
    {locations && !mapped.length && <Text style={styles.muted}>No locations are visible for this circle.</Text>}
    {!accessLost && <>
      <Text accessibilityRole="header" style={styles.label}>Members · {members.length}</Text>
      {members.map(member => <View key={member.id} style={styles.member}>
        <View style={styles.memberTitle}>
          <Text style={styles.label}>{member.name}</Text>
          <Text style={styles.muted}>{member.role === "owner" ? "Owner" : "Member"}</Text>
        </View>
        {member.status && <>
          <Text style={[styles.status, member.fix && { color: fixColors[member.status] }]}>{locationStatusLabel[member.status]}</Text>
          {member.fix && <>
            <Text style={styles.muted}>{describeFix(member.fix)}</Text>
            <Text style={styles.muted}>{member.fix.latitude.toFixed(4)}°, {member.fix.longitude.toFixed(4)}°</Text>
          </>}
        </>}
      </View>)}
    </>}
  </>;
}

const styles = StyleSheet.create({
  label: { color: "#251934", fontSize: 15, fontWeight: "600", flexShrink: 1 },
  muted: { color: "#62536e", fontSize: 14 },
  error: { color: "#862e47", backgroundColor: "#faeaf0", borderRadius: 9, padding: 10 },
  map: { height: 248, borderRadius: 12 },
  fit: { alignSelf: "flex-start", justifyContent: "center", minHeight: 44, borderRadius: 9, paddingHorizontal: 12, backgroundColor: "#f0eaf7" },
  fitText: { color: "#563b72", fontSize: 14, fontWeight: "600" },
  member: { gap: 4, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: "#e0d5eb" },
  memberTitle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  status: { color: "#62536e", fontSize: 14, fontWeight: "600" },
});
