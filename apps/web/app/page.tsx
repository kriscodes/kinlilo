"use client";

import { createCircleClient, type Circle, type CircleDetails, type CircleInvite } from "@kinlilo/contracts";
import { createAuthClient } from "better-auth/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import CircleLocations from "./CircleLocations";

const auth = createAuthClient();
const api = createCircleClient({ baseUrl: "" });

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function Brand() {
  return <a className="brand" href="/">
    <span className="brand-icon" aria-hidden="true">◉</span> Kinlilo
  </a>;
}

function AuthForm() {
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const email = String(values.get("email")).trim().toLowerCase();
    const password = String(values.get("password"));
    const name = String(values.get("name") ?? "").trim();
    if (signup && !name) {
      setError("Enter your name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = signup
        ? await auth.signUp.email({ name, email, password })
        : await auth.signIn.email({ email, password });
      if (result.error) setError(result.error.message ?? "Could not sign in.");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-shell">
    <section className="panel auth-panel" aria-labelledby="auth-title">
      <Brand />
      <h1 id="auth-title">{signup ? "Create your account" : "Welcome back"}</h1>
      <p className="muted">{signup ? "Create a circle or join one with a code." : "Sign in to open your circles."}</p>
      <form onSubmit={submit}>
        {signup && <label>Name <input name="name" autoComplete="name" required maxLength={80} /></label>}
        <label>Email <input name="email" type="email" autoComplete="email" required maxLength={254} /></label>
        <label>Password <input name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} required minLength={signup ? 12 : undefined} maxLength={128} /></label>
        {signup && <small>Use at least 12 characters.</small>}
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
      </form>
      <button type="button" className="text-button" disabled={busy} onClick={() => { setSignup(!signup); setError(""); }}>
        {signup ? "Already have an account? Sign in" : "New to Kinlilo? Create an account"}
      </button>
    </section>
  </main>;
}

function MiniForm({ label, button, maxLength, busy, onSubmit }: {
  label: string;
  button: string;
  maxLength: number;
  busy: boolean;
  onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  return <form onSubmit={async event => {
    event.preventDefault();
    if (await onSubmit(value)) setValue("");
  }}>
    <label>{label}<input value={value} onChange={event => setValue(event.target.value)}
      required maxLength={maxLength} autoComplete="off" spellCheck={false} /></label>
    <button disabled={busy || !value.trim()}>{button}</button>
  </form>;
}

function CircleWorkspace({ name }: { name: string }) {
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [detailsById, setDetailsById] = useState<CircleDetails | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [inviteResult, setInviteResult] = useState<(CircleInvite & { circleId: string }) | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const details = detailsById?.id === selectedId ? detailsById : null;
  const invite = inviteResult?.circleId === selectedId ? inviteResult : null;

  async function refresh(preferredId?: string) {
    const result = await api.list();
    setCircles(result.circles);
    setSelectedId(current => {
      const target = preferredId ?? current;
      return result.circles.some(circle => circle.id === target) ? target : result.circles[0]?.id ?? "";
    });
  }

  useEffect(() => { void refresh().catch(failure => setError(message(failure))); }, []);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    void api.get(selectedId).then(result => {
      if (active) setDetailsById(result);
    }).catch(failure => {
      if (active) setError(message(failure));
    });
    return () => { active = false; };
  }, [selectedId]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await action();
      return true;
    } catch (failure) {
      setError(message(failure));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveCircle(value: string, operation: "create" | "join") {
    return perform(async () => {
      const circle = await api[operation](value);
      setInviteResult(null);
      await refresh(circle.id);
      setStatus(operation === "create" ? "Circle created." : "You joined " + circle.name + ".");
    });
  }

  function detailContent(): ReactNode {
    if (!selectedId) return <p className="muted">{circles ? "Create or join a circle to see its members." : "Loading your circles…"}</p>;
    if (!details) return <p className="muted">{error ? "Could not load this circle." : "Loading members…"}</p>;
    return <>
      <div className="section-header"><h2>{details.name}</h2><span className="chip">{details.role === "owner" ? "Owner" : "Member"}</span></div>
      <CircleLocations key={details.id} circle={details} load={api.getLocations} />
      {details.role === "owner"
        ? <button disabled={busy} onClick={() => void perform(async () => {
            const result = await api.invite(details.id);
            setInviteResult({ ...result, circleId: details.id });
          })}>Create invitation code</button>
        : <button className="outline" disabled={busy} onClick={() => void perform(async () => {
            await api.leave(details.id);
            setDetailsById(null);
            await refresh();
            setStatus("You left " + details.name + ".");
          })}>Leave circle</button>}
      {invite && <div className="invite-box">
        <label>Invitation code<input readOnly value={invite.code} onFocus={event => event.currentTarget.select()} /></label>
        <p className="muted">One person can use this code. It expires {new Date(invite.expiresAt).toLocaleString()}.</p>
        <button className="outline" onClick={async () => {
          try { await navigator.clipboard.writeText(invite.code); setStatus("Invitation code copied."); }
          catch { setStatus("Select the code to copy it."); }
        }}>Copy code</button>
      </div>}
    </>;
  }

  return <>
    <header className="topbar"><Brand /><div><span>{name}</span>
      <button className="outline" disabled={busy} onClick={() => void perform(async () => {
        const result = await auth.signOut();
        if (result.error) throw new Error(result.error.message ?? "Could not sign out.");
      })}>Sign out</button></div>
    </header>
    <main className="workspace">
      <h1>Circles</h1><p className="muted">Create a private group or join one with an invitation.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {status && <p className="status" role="status">{status}</p>}
      <div className="workspace-grid">
        <aside className="panel circle-panel">
          <h2>Your circles</h2>
          {circles?.length === 0 && <p className="muted">You haven’t joined a circle yet.</p>}
          {circles?.map(circle => <button className="circle-tab" type="button" key={circle.id}
            aria-pressed={circle.id === selectedId} disabled={busy} onClick={() => {
              if (circle.id === selectedId) {
                void perform(async () => { setDetailsById(await api.get(circle.id)); });
                return;
              }
              setSelectedId(circle.id);
              setInviteResult(null);
              setError("");
              setStatus("");
            }}>{circle.name}</button>)}
          <hr />
          <MiniForm label="New circle name" button="Create circle" maxLength={60} busy={busy} onSubmit={value => saveCircle(value, "create")} />
          <hr />
          <MiniForm label="Invitation code" button="Join circle" maxLength={64} busy={busy} onSubmit={value => saveCircle(value, "join")} />
        </aside>
        <section className="panel details-panel" aria-label="Circle details">{detailContent()}</section>
      </div>
    </main>
  </>;
}

export default function Page() {
  const { data, isPending, error, refetch } = auth.useSession();
  if (isPending) return <main className="auth-shell"><p role="status">Loading Kinlilo…</p></main>;
  if (error) return <main className="auth-shell"><section className="panel auth-panel">
    <Brand /><h1>Can’t connect</h1><p>Check that the Kinlilo API is running.</p>
    <button onClick={() => void refetch()}>Try again</button>
  </section></main>;
  if (!data) return <AuthForm />;
  return <CircleWorkspace key={data.user.id} name={data.user.name} />;
}
