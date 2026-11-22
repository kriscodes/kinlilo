import { locationBounds, type HistoryPoint, type LocationMarker } from "@kinlilo/contracts";
import { useRef } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import MapView, { Marker, Polyline, type Region } from "react-native-maps";

function regionFor(markers: LocationMarker[]): Region {
  const { west, east, south, north } = locationBounds(markers);
  return {
    latitude: Math.max(-89, Math.min(89, (south + north) / 2)),
    longitude: (((west + east) / 2 + 540) % 360) - 180,
    latitudeDelta: Math.min(179, Math.max(0.02, (north - south) * 1.5)),
    longitudeDelta: Math.min(359, Math.max(0.02, (east - west) * 1.5)),
  };
}

export default function CircleMap({
  markers,
  paths,
  label = "Map of last reported locations",
}: {
  markers: LocationMarker[];
  paths?: HistoryPoint[][];
  label?: string;
}) {
  const map = useRef<MapView>(null);
  return (
    <>
      <MapView
        ref={map}
        initialRegion={regionFor(markers)}
        style={styles.map}
        userInterfaceStyle="light"
        accessibilityLabel={label}
      >
        {paths?.map((path) => (
          <Polyline
            key={path[0].id}
            coordinates={path.map(({ latitude, longitude }) => ({ latitude, longitude }))}
            strokeColor="#563b72"
            strokeWidth={3}
            lineDashPattern={[4, 4]}
          />
        ))}
        {markers.map(({ id, title, detail, color, fix }) => (
          <Marker
            key={id}
            title={title}
            pinColor={color}
            coordinate={{ latitude: fix.latitude, longitude: fix.longitude }}
            description={detail}
          />
        ))}
      </MapView>
      <Pressable
        accessibilityRole="button"
        style={styles.fit}
        onPress={() => map.current?.animateToRegion(regionFor(markers), 250)}
      >
        <Text style={styles.fitText}>Fit locations</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  map: { height: 248, borderRadius: 12 },
  fit: {
    alignSelf: "flex-start",
    justifyContent: "center",
    minHeight: 44,
    borderRadius: 9,
    paddingHorizontal: 12,
    backgroundColor: "#f0eaf7",
  },
  fitText: { color: "#563b72", fontSize: 14, fontWeight: "600" },
});
