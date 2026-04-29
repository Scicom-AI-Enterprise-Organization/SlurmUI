import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Compass, ArrowLeft, LayoutDashboard } from "lucide-react";

/**
 * Root-level 404 — used for any URL that doesn't match a (user) or
 * (admin) route. The (user) and (admin) layouts already wrap their own
 * children with the sidebar + header, but the root layout doesn't, so a
 * stale bookmark would otherwise dump the user onto Next.js's bare
 * default 404 page with no navigation. Render a small friendly card with
 * "back" + "dashboard" links so they always have a way back into the app.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Compass className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The URL you followed doesn&apos;t exist anymore (or never did).
          If this came from a bookmark, the page may have moved.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link href="/dashboard">
            <Button>
              <LayoutDashboard className="mr-2 h-4 w-4" />
              Dashboard
            </Button>
          </Link>
          <Link href="/">
            <Button variant="outline">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Home
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
