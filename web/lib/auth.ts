import NextAuth from "next-auth";
import KeycloakProvider from "next-auth/providers/keycloak";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
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

declare module "next-auth/jwt" {
  interface JWT {
    role?: UserRole;
    keycloakId?: string;
    userId?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_ID!,
      clientSecret: process.env.KEYCLOAK_SECRET!,
      issuer: process.env.KEYCLOAK_ISSUER!,
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name ?? profile.preferred_username,
          email: profile.email,
          keycloakId: profile.sub,
          role: (profile.groups?.includes("admin") ? "ADMIN" : "USER") as UserRole,
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
        // First login — upsert user in database
        const dbUser = await prisma.user.upsert({
          where: { keycloakId: user.keycloakId ?? user.id },
          update: {
            name: user.name,
            email: user.email!,
          },
          create: {
            keycloakId: user.keycloakId ?? user.id,
            email: user.email!,
            name: user.name,
            role: user.role ?? "USER",
          },
        });
        token.role = dbUser.role;
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
  pages: {
    signIn: "/api/auth/signin",
  },
});
