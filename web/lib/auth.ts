import NextAuth from "next-auth";
import KeycloakProvider from "next-auth/providers/keycloak";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import type { UserRole } from "@prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      role: UserRole;
      keycloakId: string;
    };
  }

  interface User {
    role?: UserRole;
    keycloakId?: string;
  }
}

// Note: v5 beta's JWT type is permissive — we just assign string fields on
// the token and cast back in the session callback.

// In-process TTL cache for User.role lookups. See lib/role-cache.ts —
// extracted so the TTL contract is unit-testable without NextAuth.
import { createRoleCache } from "./role-cache";
const roleCache = createRoleCache<UserRole>({ ttlMs: 30_000 });

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  providers: [
    // Local email+password. Only works for users with a passwordHash — i.e.
    // accounts created through an invite link. Keycloak-only users (no
    // passwordHash) cannot log in through this provider.
    CredentialsProvider({
      name: "Email & password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email.toLowerCase().trim() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || !password) return null;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) return null;
        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          keycloakId: user.keycloakId,
        };
      },
    }),
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_ID!,
      clientSecret: process.env.KEYCLOAK_SECRET!,
      issuer: process.env.KEYCLOAK_ISSUER!,
      profile(profile) {
        const realmRoles: string[] = profile.realm_access?.roles ?? [];
        const clientRoles: string[] = profile.resource_access?.[process.env.KEYCLOAK_ID!]?.roles ?? [];
        const groups: string[] = profile.groups ?? [];
        const allRoles = new Set([...realmRoles, ...clientRoles, ...groups]);
        const role: UserRole = allRoles.has("aura-admin") || allRoles.has("admin") ? "ADMIN" : "VIEWER";
        return {
          id: profile.sub,
          name: profile.name ?? profile.preferred_username,
          email: profile.email,
          keycloakId: profile.sub,
          role,
        };
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) {
        if (account?.provider === "credentials") {
          // Credentials flow — user row already exists (authorize() fetched it).
          // Trust the returned fields verbatim; role is DB-owned.
          token.role = (user.role ?? "VIEWER") as UserRole;
          token.keycloakId = user.keycloakId ?? "";
          token.userId = user.id!;
        } else {
          // Keycloak (or other upstream OIDC) — upsert, role comes from IdP.
          const role = user.role ?? "VIEWER";
          const dbUser = await prisma.user.upsert({
            where: { keycloakId: user.keycloakId ?? user.id! },
            update: {
              name: user.name,
              email: user.email!,
              role,
            },
            create: {
              keycloakId: user.keycloakId ?? user.id!,
              email: user.email!,
              name: user.name,
              role,
            },
          });
          token.role = role;
          token.keycloakId = dbUser.keycloakId;
          token.userId = dbUser.id;
        }
      } else if (token.userId) {
        // Subsequent callbacks (no `user` arg) — re-read role from the DB
        // so admin-promoted or demoted users see the change on the next
        // page load. Cached via `roleCache` (TTL above) so a page that
        // fires N parallel API calls doesn't hammer Postgres N times.
        const userId = token.userId as string;
        const cached = roleCache.get(userId);
        if (cached) {
          token.role = cached;
        } else {
          try {
            const fresh = await prisma.user.findUnique({
              where: { id: userId },
              select: { role: true },
            });
            if (fresh?.role) {
              token.role = fresh.role as UserRole;
              roleCache.set(userId, fresh.role as UserRole);
            }
          } catch {}
        }
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId as string;
      session.user.role = token.role as UserRole;
      session.user.keycloakId = token.keycloakId as string;
      return session;
    },
  },
});
