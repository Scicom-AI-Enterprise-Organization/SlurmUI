"use client";

import { signIn } from "next-auth/react";
import { motion } from "framer-motion";
import { ShieldCheck, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen bg-background">
      {/* Left — Branded Panel */}
      <div className="relative hidden w-1/2 items-center justify-center overflow-hidden bg-primary lg:flex">
        {/* Decorative circles */}
        <div className="absolute inset-0 opacity-10">
          {Array.from({ length: 20 }).map((_, i) => (
            <div
              key={i}
              className="absolute h-32 w-32 rounded-full border border-white"
              style={{
                top: `${(i * 37) % 100}%`,
                left: `${(i * 53) % 100}%`,
                transform: `scale(${0.5 + (i % 4) * 0.5})`,
              }}
            />
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 px-10 text-center"
        >
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-white/20 backdrop-blur">
            <KeyRound className="h-8 w-8 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold text-primary-foreground">SlurmUI</h1>
          <p className="mt-2 text-sm text-primary-foreground/70">
            HPC cluster management for researchers
          </p>
          <div className="mx-auto mt-8 flex max-w-[220px] items-center gap-3 rounded-lg bg-white/10 px-4 py-3 backdrop-blur">
            <ShieldCheck className="h-5 w-5 shrink-0 text-primary-foreground" />
            <div className="text-left text-xs text-primary-foreground">
              <div className="font-medium">Keycloak SSO</div>
              <div className="opacity-70">Federated identity &amp; access</div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Right — Sign-in Form */}
      <div className="flex w-full flex-col items-center justify-center px-6 lg:w-1/2 lg:px-10">
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4 }}
          className="w-full max-w-[340px]"
        >
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <KeyRound className="h-5 w-5 text-primary" />
            <span className="text-lg font-bold">SlurmUI</span>
          </div>

          <h2 className="text-xl font-semibold text-foreground">Single Sign-On</h2>
          <p className="mt-1 mb-8 text-sm text-muted-foreground">
            Sign in with your corporate account
          </p>

          <motion.div whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}>
            <Button
              className="w-full gap-2"
              size="lg"
              onClick={() => signIn("keycloak", { callbackUrl: "/dashboard" })}
            >
              <ShieldCheck className="h-4 w-4" />
              Continue with Keycloak
            </Button>
          </motion.div>

        </motion.div>
      </div>
    </div>
  );
}
