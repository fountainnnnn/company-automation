import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "../components/Button";

export function LoginPage() {
  const { session, loading, signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [busy, setBusy] = useState(false);

  if (!loading && session) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
      setShakeKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="orb" aria-hidden="true" />
      <div className="login-wrap">
        <div className="login-card reveal">
          <span className="brand">
            <span className="side-mark" aria-hidden="true">
              CL
            </span>
            CL Automation
          </span>
          <h1>Sign in</h1>
          <p className="sub">
            Every site photo, note and check-in — filed by project, date and worker.
          </p>

          <form className="login-form" onSubmit={onSubmit} noValidate>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            {error && (
              <p className="form-error shake" role="alert" key={shakeKey}>
                {error}
              </p>
            )}

            <Button type="submit" variant="primary" size="lg" loading={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>

            <p className="muted" style={{ fontSize: "0.8rem", textAlign: "center" }}>
              Accounts are created by an administrator.
            </p>
          </form>
        </div>
      </div>
    </>
  );
}
