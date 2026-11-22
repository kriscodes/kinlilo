import type { Circle, CircleDetails, CircleInvite } from "@kinlilo/contracts";
import * as Location from "expo-location";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import {
  clearLocationDiagnostics, getLocationDiagnosticReport, getLocationHarnessStatus, locationHarnessEnabled,
  startLocationHarness, stopLocationHarness,
} from "./locationHarness";
import {
  getSharingSnapshot, locationSharingAvailable, pauseBeforeSigningOut, pauseLocationSharing,
  setSharingAccount, startLocationSharing, subscribeToSharing, watchLocationSharing,
} from "./locationSharing";
import { api, auth } from "./mobileApi";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function Button({ title, onPress, disabled = false, secondary = false }: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
    style={[styles.button, secondary && styles.secondary, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text>
  </Pressable>;
}

function Field({ label, value, onChangeText, maxLength, password, email, newPassword }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  maxLength?: number;
  password?: boolean;
  email?: boolean;
  newPassword?: boolean;
}) {
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} style={styles.input} value={value} onChangeText={onChangeText}
      autoCapitalize="none" autoCorrect={false} keyboardType={email ? "email-address" : "default"}
      autoComplete={email ? "email" : password ? newPassword ? "new-password" : "current-password" : undefined}
      secureTextEntry={password} maxLength={maxLength} />
  </View>;
}

function SignIn() {
  const [signup, setSignup] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const identity = { email: email.trim().toLowerCase(), password };
      const result = signup ? await auth.signUp.email({ ...identity, name: name.trim() }) : await auth.signIn.email(identity);
      if (result.error) setError(result.error.message ?? "Could not sign in.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.heading}>{signup ? "Create your account" : "Welcome back"}</Text>
    {signup && <Field label="Name" value={name} onChangeText={setName} maxLength={80} />}
    <Field label="Email" value={email} onChangeText={setEmail} email maxLength={254} />
    <Field label={signup ? "Password (12 characters or more)" : "Password"} value={password} onChangeText={setPassword}
      password newPassword={signup} maxLength={128} />
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <Button title={signup ? "Create account" : "Sign in"} onPress={() => void submit()}
      disabled={busy || !email.trim() || !password || (signup && (!name.trim() || password.length < 12))} />
    <Button title={signup ? "Back to sign in" : "Create an account"} secondary disabled={busy}
      onPress={() => { setError(""); setSignup(!signup); }} />
  </View>;
}

function CircleHome({ name, accountId, sharing }: {
  name: string;
  accountId: string;
  sharing: ReturnType<typeof getSharingSnapshot>;
}) {
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [selected, setSelected] = useState<CircleDetails | null>(null);
  const [invite, setInvite] = useState<CircleInvite | null>(null);
  const [circleName, setCircleName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void api.list().then(result => {
      if (active) setCircles(result.circles);
    }).catch(failure => {
      if (active) setError(errorMessage(failure));
    });
    return () => { active = false; };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function open(id: string) {
    setInvite(null);
    setSelected(await api.get(id));
  }

  async function refresh() {
    setCircles((await api.list()).circles);
  }

  return <>
    <Text style={styles.muted}>{name}</Text>
    <Button title="Sign out" secondary disabled={busy} onPress={() => void run(async () => {
      await pauseBeforeSigningOut(accountId);
      const result = await auth.signOut();
      if (result.error) throw new Error(result.error.message ?? "Could not sign out.");
    })} />
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>Your circles</Text>
      {circles === null && !error && <ActivityIndicator />}
      {circles?.length === 0 && <Text style={styles.muted}>You haven’t joined a circle yet.</Text>}
      {circles?.map(circle => <Button key={circle.id} title={circle.name} secondary disabled={busy}
        onPress={() => void run(() => open(circle.id))} />)}
      <Field label="New circle name" value={circleName} onChangeText={setCircleName} maxLength={60} />
      <Button title="Create circle" disabled={busy || !circleName.trim()} onPress={() => void run(async () => {
        const circle = await api.create(circleName);
        setCircleName("");
        await refresh();
        await open(circle.id);
      })} />
      <Field label="Invitation code" value={code} onChangeText={setCode} maxLength={64} />
      <Button title="Join circle" disabled={busy || !code.trim()} onPress={() => void run(async () => {
        const circle = await api.join(code);
        setCode("");
        await refresh();
        await open(circle.id);
      })} />
    </View>
    {selected && <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.heading}>{selected.name}</Text>
      <Text style={styles.label}>Members · {selected.memberCount}</Text>
      {selected.members.map(member => <View key={member.id} style={styles.member}>
        <Text style={styles.body}>{member.name}</Text>
        <Text style={styles.muted}>{member.role === "owner" ? "Owner" : "Member"}</Text>
      </View>)}
      {locationSharingAvailable && !sharing.state && !sharing.error && <>
        <Text style={styles.muted}>Share this iPhone’s location in this circle, including in the background.</Text>
        <Button title="Start location sharing" disabled={busy}
          onPress={() => void run(() => startLocationSharing(accountId, selected.id))} />
      </>}
      {selected.role === "owner" ? <Button title="Create invitation code" disabled={busy}
        onPress={() => void run(async () => { setInvite(await api.invite(selected.id)); })} />
        : <Button title="Leave circle" secondary disabled={busy} onPress={() => void run(async () => {
          if (locationSharingAvailable) await pauseLocationSharing({ accountId, circleId: selected.id });
          await api.leave(selected.id);
          setSelected(null);
          await refresh();
        })} />}
      {invite && <>
        <Text style={styles.label}>Invitation code</Text>
        <Text selectable style={styles.code}>{invite.code}</Text>
        <Text style={styles.muted}>One use. Expires {new Date(invite.expiresAt).toLocaleString()}.</Text>
        <Button title="Share code" secondary onPress={() => void run(async () => {
          await Share.share({ message: invite.code });
        })} />
      </>}
    </View>}
  </>;
}

function LocationHarness() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getLocationHarnessStatus>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const actionInProgress = useRef(false);

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const next = await getLocationHarnessStatus();
        if (mounted && !actionInProgress.current) setStatus(next);
      } catch {
        if (mounted && !actionInProgress.current) setError("Could not read the location test status.");
      }
    }
    void refresh();
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void refresh();
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  async function run(action?: () => Promise<unknown>) {
    if (actionInProgress.current) return;
    actionInProgress.current = true;
    setBusy(true);
    setError("");
    try {
      await action?.();
    } catch (failure) {
      setError(errorMessage(failure));
    }
    try {
      setStatus(await getLocationHarnessStatus());
    } catch {
      setError(previous => previous || "Could not read the location test status.");
    } finally {
      actionInProgress.current = false;
      setBusy(false);
    }
  }

  const testEnabled = status !== undefined && status.startedAt !== null;
  const testActive = testEnabled || status?.registered;
  const latest = status?.latest;
  const sampleCount = latest?.sample_count ?? 0;
  const sampleLabel = sampleCount === 1 ? "1 location sample" : `${sampleCount} location samples`;
  return <View style={styles.card}>
    <Text accessibilityRole="header" style={styles.heading}>iOS location test</Text>
    <Text style={styles.body}>Start the test to measure location callbacks while the app is open, backgrounded, or the phone is locked. The test saves timing and synthetic Keychain probe results on this device. Use Stop test to turn capture off.</Text>
    {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    {status ? <>
      <Text style={styles.label}>{testEnabled ? "Capture enabled" : "Capture off"} · {status.registered ? "iOS task registered" : "iOS task unregistered"}</Text>
      <Text style={styles.muted}>When In Use: {status.foreground.status} · Always: {status.background.status}</Text>
      {status.foreground.granted && status.foreground.ios?.accuracy &&
        <Text style={styles.muted}>Location accuracy authorization: {status.foreground.ios.accuracy}</Text>}
      {!status.foreground.granted && <Button title="Request When In Use" secondary disabled={busy || !status.foreground.canAskAgain}
        onPress={() => void run(Location.requestForegroundPermissionsAsync)} />}
      {status.foreground.granted && !status.background.granted && <Button title="Request Always" secondary disabled={busy || !status.background.canAskAgain}
        onPress={() => void run(Location.requestBackgroundPermissionsAsync)} />}
      {testActive ? <Button title="Stop test" disabled={busy} onPress={() => void run(stopLocationHarness)} />
        : <Button title="Start test" disabled={busy || !status.foreground.granted || !status.background.granted}
          onPress={() => void run(startLocationHarness)} />}
      <Text style={styles.label}>Queued callbacks: {status.queued}</Text>
      {latest && <>
        <Text style={styles.body}>Latest callback {new Date(latest.received_at).toLocaleString()} · {latest.app_state}</Text>
        <Text style={styles.muted}>{latest.task_error ? "iOS reported a location task error." : sampleLabel}</Text>
        <Text style={styles.muted}>After first unlock: {latest.after_first_unlock} · While unlocked: {latest.while_unlocked}</Text>
      </>}
      {status.queued > 0 && <>
        <Button title="Share diagnostic report" secondary disabled={busy}
          onPress={() => void run(async () => { await Share.share({ message: await getLocationDiagnosticReport() }); })} />
        <Button title="Clear diagnostics" secondary disabled={busy || testActive}
          onPress={() => void run(clearLocationDiagnostics)} />
      </>}
    </> : !error && <ActivityIndicator accessibilityLabel="Loading test status" />}
    <Button title="Refresh status" secondary disabled={busy} onPress={() => void run()} />
    <Button title="Open iOS Settings" secondary disabled={busy} onPress={() => void run(Linking.openSettings)} />
  </View>;
}

function AccountWorkspace({ session, sharing }: {
  session: ReturnType<typeof auth.useSession>;
  sharing: ReturnType<typeof getSharingSnapshot>;
}) {
  if (session.isPending) return <ActivityIndicator accessibilityLabel="Loading Kinlilo" />;
  if (session.error) return <>
    <Text accessibilityRole="alert" style={styles.error}>Couldn’t connect to Kinlilo.</Text>
    <Button title="Try again" onPress={() => void session.refetch()} />
  </>;
  return session.data ? <CircleHome name={session.data.user.name} accountId={session.data.user.id}
    sharing={sharing} key={session.data.user.id} /> : <SignIn />;
}

function LocalSharingStatus({ sharing, accountId }: {
  sharing: ReturnType<typeof getSharingSnapshot>;
  accountId: string | null | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { state } = sharing;
  if (!state && !sharing.error) return null;

  async function pause() {
    setBusy(true);
    setError("");
    try { await pauseLocationSharing(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <View style={styles.card}>
    {state?.phase === "active" && <>
      <Text accessibilityRole="header" style={styles.heading}>Location sharing is on</Text>
      <Text style={styles.muted}>Queued fixes: {state.queued}</Text>
      {state.dropped > 0 && <Text style={styles.muted}>Discarded fixes: {state.dropped}</Text>}
      <Button title="Pause location sharing" disabled={busy} onPress={() => void pause()} />
    </>}
    {state?.phase === "pausing" && <>
      <Text accessibilityRole="header" style={styles.heading}>Pause pending</Text>
      <Text style={styles.muted}>{accountId === state.accountId
        ? "Capture and uploads have stopped on this iPhone. Kinlilo will confirm the pause when it can reach the server."
        : "Capture and uploads have stopped on this iPhone. Sign in with the account that started sharing to confirm the pause."}</Text>
    </>}
    {(error || sharing.error) && <Text accessibilityRole="alert" style={styles.error}>{error || sharing.error}</Text>}
  </View>;
}

export default function App() {
  const [showHarness, setShowHarness] = useState(false);
  const session = auth.useSession();
  const accountId = session.error || session.isPending ? undefined : session.data?.user.id ?? null;
  const sharing = useSyncExternalStore(subscribeToSharing, getSharingSnapshot);
  useEffect(watchLocationSharing, []);
  useEffect(() => { setSharingAccount(accountId); }, [accountId]);
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
    contentInsetAdjustmentBehavior="automatic">
    <Text accessibilityRole="header" style={styles.brand}>Kinlilo</Text>
    {locationHarnessEnabled && <Button title={showHarness ? "Back to Kinlilo" : "Open iOS location test"} secondary
      onPress={() => setShowHarness(!showHarness)} />}
    {locationSharingAvailable && <LocalSharingStatus sharing={sharing} accountId={accountId} />}
    {showHarness ? <LocationHarness /> : <AccountWorkspace session={session} sharing={sharing} />}
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f7f3fb" },
  content: { padding: 22, paddingBottom: 50, gap: 14 },
  brand: { color: "#251934", fontSize: 36, fontWeight: "800" },
  heading: { color: "#251934", fontSize: 24, fontWeight: "700" },
  body: { color: "#251934", fontSize: 16, flexShrink: 1 },
  muted: { color: "#62536e", fontSize: 14 },
  card: { backgroundColor: "#fcfafe", borderColor: "#e0d5eb", borderWidth: 1, borderRadius: 18, padding: 18, gap: 12 },
  field: { gap: 6 },
  label: { color: "#251934", fontWeight: "600", fontSize: 15 },
  input: { color: "#251934", backgroundColor: "#fff", borderWidth: 1, borderColor: "#b8a9c6", borderRadius: 10, padding: 12, minHeight: 48, fontSize: 16 },
  button: { backgroundColor: "#563b72", borderRadius: 10, minHeight: 46, justifyContent: "center", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16, textAlign: "center" },
  secondary: { backgroundColor: "#f0eaf7" },
  secondaryText: { color: "#563b72" },
  disabled: { opacity: 0.55 },
  error: { color: "#862e47", backgroundColor: "#faeaf0", borderRadius: 9, padding: 10 },
  member: { flexDirection: "row", justifyContent: "space-between", gap: 8, borderBottomWidth: 1, borderBottomColor: "#e0d5eb", paddingBottom: 8 },
  code: { color: "#251934", backgroundColor: "#f0eaf7", borderRadius: 9, padding: 10 },
});
