import NextAuth from "next-auth";
import KeycloakProvider from "next-auth/providers/keycloak";
import { PrismaAdapter } from "@auth/prisma-adapter";
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

declare module "@auth/core/jwt" {
  interface JWT {
    role?: UserRole;
    keycloakId?: string;
    userId?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_ID!,
      clientSecret: process.env.KEYCLOAK_SECRET!,
      issuer: process.env.KEYCLOAK_ISSUER!,
      profile(profile) {
        const realmRoles: string[] = profile.realm_access?.roles ?? [];
        const clientRoles: string[] = profile.resource_access?.[process.env.KEYCLOAK_ID!]?.roles ?? [];
        const groups: string[] = profile.groups ?? [];
        const allRoles = new Set([...realmRoles, ...clientRoles, ...groups]);
        const role: UserRole = allRoles.has("aura-admin") || allRoles.has("admin") ? "ADMIN" : "USER";
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
        // Upsert user in database — role always comes from Keycloak
        const role = user.role ?? "USER";
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
