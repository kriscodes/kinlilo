import { expoClient } from "@better-auth/expo/client";
import { createCircleClient, type Circle, type CircleDetails, type CircleInvite } from "@kinlilo/contracts";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";

const baseURL = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:4311";
const auth = createAuthClient({
  baseURL,
  plugins: [expoClient({ scheme: "kinlilo", storagePrefix: "kinlilo", cookiePrefix: "kinlilo", storage: SecureStore })],
});

const api = createCircleClient({
  baseUrl: baseURL,
  credentials: "omit",
  headers: async () => ({ Cookie: await auth.getCookie(), "X-Kinlilo-Client": "mobile" }),
});

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

function CircleHome({ name }: { name: string }) {
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
      {selected.role === "owner" ? <Button title="Create invitation code" disabled={busy}
        onPress={() => void run(async () => { setInvite(await api.invite(selected.id)); })} />
        : <Button title="Leave circle" secondary disabled={busy} onPress={() => void run(async () => {
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

export default function App() {
  const session = auth.useSession();
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
    contentInsetAdjustmentBehavior="automatic">
    <Text accessibilityRole="header" style={styles.brand}>Kinlilo</Text>
    {session.isPending ? <ActivityIndicator accessibilityLabel="Loading Kinlilo" />
      : session.error ? <>
        <Text accessibilityRole="alert" style={styles.error}>Couldn’t connect to Kinlilo.</Text>
        <Button title="Try again" onPress={() => void session.refetch()} />
      </>
      : session.data ? <CircleHome name={session.data.user.name} key={session.data.user.id} /> : <SignIn />}
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
