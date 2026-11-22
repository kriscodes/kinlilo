import {
  describeFix, hasHistoryGap, historyDay, historyLocationMarkers, historyPaths, localDateString, type CircleDetails,
} from "@kinlilo/contracts";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import CircleMap from "./CircleMap";
import { api } from "./mobileApi";
import { useLocationQuery } from "./useLocationQuery";

function HistoryPage({ circleId, memberId, from, to, cursor, previous, next }: {
  circleId: string; memberId: string; from: string; to: string; cursor?: string;
  previous?: () => void; next: (cursor: string) => void;
}) {
  const load = useCallback((signal: AbortSignal) => api.getLocationHistory(circleId, memberId, { from, to, cursor }, signal),
    [circleId, memberId, from, to, cursor]);
  const { data, error } = useLocationQuery(load);
  const points = data?.points ?? [];
  const nextCursor = data?.nextCursor;
  return <>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {!error && !data && <Text style={styles.muted}>Loading history…</Text>}
    {data?.status === "sharing_off" && <Text style={styles.muted}>This member’s history is available while they’re sharing.</Text>}
    {data?.status === "available" && !points.length && <Text style={styles.muted}>No retained fixes for this selection.</Text>}
    {(previous || nextCursor) && <View style={styles.controls}>
      {previous && <Pressable accessibilityRole="button" style={styles.button} onPress={previous}><Text style={styles.label}>Earlier fixes</Text></Pressable>}
      {nextCursor && <Pressable accessibilityRole="button" style={styles.button} onPress={() => next(nextCursor)}><Text style={styles.label}>Later fixes</Text></Pressable>}
    </View>}
    {points.length > 0 && <>
      <CircleMap markers={historyLocationMarkers(points)} paths={historyPaths(points)} label="Map of recorded fixes" />
      <Text accessibilityRole="header" style={styles.label}>Recorded fixes</Text>
      {points.map((point, index) => <View key={point.id} style={styles.fix}>
        {hasHistoryGap(points[index - 1], point) && <Text style={styles.gap}>Gap in reporting</Text>}
        <Text style={styles.label}>{describeFix(point)}</Text>
        <Text style={styles.muted}>{point.latitude.toFixed(4)}°, {point.longitude.toFixed(4)}°</Text>
      </View>)}
    </>}
  </>;
}

export default function CircleHistory({ circle, viewerId }: { circle: CircleDetails; viewerId: string }) {
  const [memberId, setMemberId] = useState(viewerId);
  const [date, setDate] = useState(() => new Date());
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const cursor = pages.at(-1) ?? undefined;
  const day = historyDay(localDateString(date));
  return <>
    <Text accessibilityRole="header" style={styles.title}>Location history</Text>
    <Text style={styles.label}>Circle member</Text>
    <ScrollView horizontal contentContainerStyle={styles.controls} showsHorizontalScrollIndicator={false}>
      {circle.members.map(member => <Pressable key={member.id} accessibilityRole="button" accessibilityLabel={member.name}
        accessibilityState={{ selected: member.id === memberId }} style={[styles.button, member.id === memberId && styles.selected]}
        onPress={() => { setMemberId(member.id); setPages([null]); }}>
        <Text numberOfLines={1} style={[styles.label, member.id === memberId && styles.selectedText]}>{member.name}</Text>
      </Pressable>)}
    </ScrollView>
    <View style={styles.date}>
      <Text style={styles.label}>Date</Text>
      <DateTimePicker value={date} mode="date" display="compact" maximumDate={new Date()}
        onChange={(_, selected) => { if (selected) { setDate(selected); setPages([null]); } }} />
    </View>
    {day && <HistoryPage key={`${memberId}/${day.from}/${cursor ?? ""}`} circleId={circle.id} memberId={memberId}
      from={day.from} to={day.to} cursor={cursor}
      previous={pages.length > 1 ? () => setPages(current => current.slice(0, -1)) : undefined}
      next={next => setPages(current => [...current, next])} />}
  </>;
}

const styles = StyleSheet.create({
  title: { color: "#251934", fontSize: 18, fontWeight: "700" },
  label: { color: "#251934", fontSize: 15, fontWeight: "600" },
  muted: { color: "#62536e", fontSize: 14 },
  error: { color: "#862e47", backgroundColor: "#faeaf0", borderRadius: 9, padding: 10 },
  controls: { flexDirection: "row", gap: 8 },
  button: { maxWidth: 210, minHeight: 44, justifyContent: "center", borderRadius: 9, paddingHorizontal: 12, backgroundColor: "#f0eaf7" },
  selected: { backgroundColor: "#563b72" },
  selectedText: { color: "white" },
  date: { flexDirection: "row", alignItems: "center", gap: 12 },
  fix: { gap: 4, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: "#e0d5eb" },
  gap: { color: "#805218", fontWeight: "700", marginVertical: 4 },
});
