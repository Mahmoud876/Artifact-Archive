"use client";

import { FormEvent, ReactNode, createContext, useContext, useEffect, useState } from "react";

type SessionUser = { id: string; username: string; displayName: string };
type AuthContextValue = { user: SessionUser; signOut: () => Promise<void> };

const AuthContext = createContext<AuthContextValue | null>(null);

export function useLocalAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useLocalAuth must be used inside AuthGate.");
  return value;
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => response.ok ? await response.json() as { user: SessionUser } : null)
      .then((payload) => { if (active) setUser(payload?.user ?? null); })
      .catch(() => { if (active) setUser(null); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  };

  if (checking) {
    return <div className="auth-loading"><span className="auth-emblem" /><p>Opening the archive...</p></div>;
  }
  if (!user) return <LoginScreen onAuthenticated={setUser} />;
  return <AuthContext.Provider value={{ user, signOut }}>{children}</AuthContext.Provider>;
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: SessionUser) => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: String(form.get("username") ?? ""),
          password,
        }),
      });
      const payload = await response.json() as { user?: SessionUser; error?: string };
      if (!response.ok || !payload.user) {
        throw new Error(payload.error || "The request could not be completed.");
      }
      onAuthenticated(payload.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  return <main className="login-page">
    <section className="login-introduction">
      <span className="login-kicker">SESHAT · LOCAL ARCHIVE</span>
      <span className="auth-emblem" aria-hidden="true" />
      <h1>Archive every image.<br /><em>Preserve every number.</em></h1>
      <p>Sign in to enter the image extraction and serialisation workspace.</p>
    </section>
    <section className="login-panel" aria-labelledby="login-title">
      <div className="login-language">العربية · English</div>
      <div className="login-form-wrap">
        <span className="login-step">SECURE LOCAL ACCESS</span>
        <h2 id="login-title">Welcome back</h2>
        <p>Enter the account details provided by the Seshat administrator.</p>
        <form className="auth-form" onSubmit={submit}>
          <label>Username<input name="username" type="text" autoComplete="username" minLength={3} maxLength={64} required placeholder="username" /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" minLength={8} maxLength={128} required placeholder="Password" /></label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? "Please wait..." : "Enter the archive"}
          </button>
        </form>
        <p className="auth-local-note">Public account creation is disabled. Accounts remain hashed in <code>data/accounts.json</code>.</p>
      </div>
    </section>
  </main>;
}
