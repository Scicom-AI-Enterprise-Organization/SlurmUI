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

  // Only ADMIN can mutate. Non-admins (VIEWER, plus any legacy USER rows
  // that survived before the role collapse) get 403 on non-GET API calls.
  if (
    session.user.role !== "ADMIN" &&
    isApiRoute &&
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.method !== "OPTIONS"
  ) {
    return NextResponse.json(
      { error: "Viewer role is read-only" },
      { status: 403 }
    );
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
    // Exclude /api/v1/* — those endpoints accept Bearer tokens (see
    // lib/api-auth.ts) and do their own role checks, so the session-cookie
    // gate below would wrongly 401 token-authenticated callers.
    //
    // /job-proxy/* is also excluded: the route handler itself checks
    // `Job.proxyPublic` before falling back to session auth, so we must
    // NOT redirect unauth users to /login here — that'd defeat the
    // public-proxy toggle.
    "/((?!_next/static|_next/image|favicon.ico|scicom-logo|api/health|api/install|api/metrics|api/v1|login|invite|reset|api/invites/by-token|api/password-reset/by-token|job-proxy).*)",
  ],
};
