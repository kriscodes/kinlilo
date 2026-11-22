import {
  describeFix,
  fixColors,
  hasLocationFix,
  latestLocationMarkers,
  locationStatusLabel,
  type CircleDetails,
} from "@kinlilo/contracts";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import CircleHistory from "./CircleHistory";
import CircleMap from "./CircleMap";
import { api } from "./mobileApi";
import { useLocationQuery } from "./useLocationQuery";

export default function CircleLocations({ circle, viewerId }: { circle: CircleDetails; viewerId: string }) {
  const [view, setView] = useState<"Latest" | "History">("Latest");
  return (
    <>
      <View style={styles.viewButtons}>
        {(["Latest", "History"] as const).map((option) => (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityState={{ selected: view === option }}
            style={[styles.viewButton, view === option && styles.selected]}
            onPress={() => setView(option)}
          >
            <Text style={[styles.viewButtonText, view === option && styles.selectedText]}>{option}</Text>
          </Pressable>
        ))}
      </View>
      {view === "Latest" ? (
        <LatestLocations circle={circle} />
      ) : (
        <CircleHistory circle={circle} viewerId={viewerId} />
      )}
    </>
  );
}

function LatestLocations({ circle }: { circle: CircleDetails }) {
  const load = useCallback((signal: AbortSignal) => api.getLocations(circle.id, signal), [circle.id]);
  const { data: locations, error, accessLost } = useLocationQuery(load);

  const members =
    locations?.members ?? circle.members.map((member) => ({ ...member, status: null, fix: null }));
  const mapped = locations?.members.filter(hasLocationFix) ?? [];
  return (
    <>
      <Text accessibilityRole="header" style={styles.label}>
        Last reported locations
      </Text>
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {!error && !locations && <Text style={styles.muted}>Loading locations…</Text>}
      {mapped.length > 0 && <CircleMap markers={latestLocationMarkers(mapped)} />}
      {locations && !mapped.length && (
        <Text style={styles.muted}>No locations are visible for this circle.</Text>
      )}
      {!accessLost && (
        <>
          <Text accessibilityRole="header" style={styles.label}>
            Members · {members.length}
          </Text>
          {members.map((member) => (
            <View key={member.id} style={styles.member}>
              <View style={styles.memberTitle}>
                <Text style={styles.label}>{member.name}</Text>
                <Text style={styles.muted}>{member.role === "owner" ? "Owner" : "Member"}</Text>
              </View>
              {member.status && (
                <>
                  <Text style={[styles.status, member.fix && { color: fixColors[member.status] }]}>
                    {locationStatusLabel[member.status]}
                  </Text>
                  {member.fix && (
                    <>
                      <Text style={styles.muted}>{describeFix(member.fix)}</Text>
                      <Text style={styles.muted}>
                        {member.fix.latitude.toFixed(4)}°, {member.fix.longitude.toFixed(4)}°
                      </Text>
                    </>
                  )}
                </>
              )}
            </View>
          ))}
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  label: { color: "#251934", fontSize: 15, fontWeight: "600", flexShrink: 1 },
  muted: { color: "#62536e", fontSize: 14 },
  error: { color: "#862e47", backgroundColor: "#faeaf0", borderRadius: 9, padding: 10 },
  viewButtons: { flexDirection: "row", gap: 8 },
  viewButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    borderRadius: 9,
    backgroundColor: "#f0eaf7",
  },
  viewButtonText: { color: "#563b72", fontSize: 15, fontWeight: "600" },
  selected: { backgroundColor: "#563b72" },
  selectedText: { color: "#fff" },
  member: { gap: 4, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: "#e0d5eb" },
  memberTitle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  status: { color: "#62536e", fontSize: 14, fontWeight: "600" },
});
