"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { motion } from "framer-motion";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface InviteInfo {
  role: "ADMIN" | "USER" | "VIEWER";
  email: string | null;
  expiresAt: string;
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/invites/by-token/${token}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(await r.json().catch(() => ({})))))
      .then((d: InviteInfo) => {
        setInfo(d);
        if (d.email) setEmail(d.email);
      })
      .catch((e) => setLoadErr(e?.error ?? "Invalid or expired invite"))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitErr(null);
    if (password.length < 8) return setSubmitErr("Password must be at least 8 characters");
    if (password !== confirm) return setSubmitErr("Passwords don't match");
    setSubmitting(true);
    try {
      const res = await fetch(`/api/invites/by-token/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitErr(d.error ?? `Server returned ${res.status}`);
        return;
      }
      // Auto-login via the credentials provider.
      const login = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (login?.error) {
        setSubmitErr("Account created but login failed. Try signing in.");
        setTimeout(() => router.push("/login"), 1500);
        return;
      }
      router.push("/dashboard");
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadErr || !info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md space-y-3 text-center">
          <KeyRound className="mx-auto h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Invite unavailable</h1>
          <p className="text-sm text-muted-foreground">
            {loadErr ?? "This invite link is no longer valid."}
          </p>
          <Button variant="outline" onClick={() => router.push("/login")}>Back to sign in</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <motion.form
        onSubmit={submit}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm space-y-5"
      >
        <div className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold">Accept invite</h1>
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            You&apos;re being added as <Badge>{info.role}</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Expires {new Date(info.expiresAt).toLocaleString()}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={!!info.email}
          />
          {info.email && (
            <p className="text-xs text-muted-foreground">Email is locked by the invite.</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="name">Name (optional)</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password (min 8 chars)</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {submitErr && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
            {submitErr}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create account
        </Button>
      </motion.form>
    </div>
  );
}
