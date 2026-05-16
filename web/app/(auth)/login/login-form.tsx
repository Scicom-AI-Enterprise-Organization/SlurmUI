"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const ERROR_MESSAGES: Record<string, string> = {
  CredentialsSignin: "Invalid email or password.",
  OAuthSignin: "Could not start Keycloak sign-in. Please try again.",
  OAuthCallback: "Keycloak callback failed. Please try again.",
  Callback: "Authentication callback failed. Please try again.",
  AccessDenied: "Access denied.",
  SessionRequired: "Please sign in to continue.",
};

export function LoginForm({
  callbackUrl,
  keycloakEnabled,
  initialError,
}: {
  callbackUrl: string;
  keycloakEnabled: boolean;
  initialError?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState(
    initialError ? ERROR_MESSAGES[initialError] ?? `Sign in failed: ${initialError}` : "",
  );
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await signIn("credentials", {
        email: email.toLowerCase().trim(),
        password,
        redirect: false,
      });
      if (!res) {
        setError("No response from server.");
        return;
      }
      if (res.error) {
        setError("Invalid email or password.");
        return;
      }
      router.replace(callbackUrl);
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Icon */}
      <div className="mb-6 flex justify-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
          <Lock className="size-6 text-primary" />
        </div>
      </div>

      {/* Heading */}
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-foreground">Welcome back</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sign in to your account
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        {/* Email */}
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium text-foreground">
            Email
          </label>
          <div className="flex h-11 items-center gap-2 rounded-lg border border-transparent bg-slate-100 px-3 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 dark:bg-slate-900">
            <Mail className="size-4 shrink-0 text-muted-foreground" />
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="autofill-fix flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Password */}
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium text-foreground">
            Password
          </label>
          <div className="flex h-11 items-center gap-2 rounded-lg border border-transparent bg-slate-100 px-3 transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 dark:bg-slate-900">
            <Lock className="size-4 shrink-0 text-muted-foreground" />
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="autofill-fix flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        {/* Remember me + Forgot */}
        <div className="flex items-center justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => setRememberMe(!rememberMe)}
              className={`flex size-4 items-center justify-center rounded border transition-colors ${
                rememberMe
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background"
              }`}
              aria-label="Remember me"
            >
              {rememberMe && <Check className="size-3" />}
            </button>
            <span className="text-muted-foreground">Remember me</span>
          </label>
          <button
            type="button"
            onClick={() => setShowForgot(true)}
            className="text-sm text-primary hover:underline"
          >
            Forgot?
          </button>
        </div>

        <Button type="submit" className="h-11 w-full" disabled={loading}>
          {loading && <Loader2 className="size-4 animate-spin" />}
          {loading ? "Signing in..." : "Sign in"}
        </Button>
      </form>

      {keycloakEnabled && (
        <>
          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or continue with</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            onClick={() => signIn("keycloak", { callbackUrl })}
          >
            <KeyRound className="size-4" />
            Keycloak
          </Button>
        </>
      )}

      <p className="mt-6 text-center text-sm text-muted-foreground">
        No account? Ask an admin for an invite link.
      </p>

      {showForgot && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowForgot(false)}
        >
          <div
            className="w-full max-w-sm rounded-lg border bg-background p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <KeyRound className="size-4 text-primary" />
              <h2 className="text-base font-semibold">Reset password</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Ask an organization admin to generate a password reset link for
              you from the Organization page.
            </p>
            <div className="mt-5 flex justify-end">
              <Button size="sm" onClick={() => setShowForgot(false)}>
                Got it
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
