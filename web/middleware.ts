import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { nextUrl, auth: session } = req;
  const isLoggedIn = !!session?.user;
  const isAuthRoute = nextUrl.pathname.startsWith("/api/auth");
  const isAdminRoute =
    nextUrl.pathname.startsWith("/admin") ||
    nextUrl.pathname.startsWith("/api/clusters") && req.method !== "GET";
  const isApiRoute = nextUrl.pathname.startsWith("/api");

  // Allow auth routes through
  if (isAuthRoute) return NextResponse.next();

  // Redirect unauthenticated users to sign in
  if (!isLoggedIn) {
    if (isApiRoute) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/api/auth/signin", nextUrl));
  }

  // Block non-admins from admin routes
  if (isAdminRoute && session.user.role !== "ADMIN") {
    if (isApiRoute) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/dashboard", nextUrl));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public files
     */
    "/((?!_next/static|_next/image|favicon.ico|public|api/health|api/install|api/metrics|login).*)",
  ],
};
