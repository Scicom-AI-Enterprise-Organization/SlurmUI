import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function AdminGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/api/auth/signin");
  }

  return <>{children}</>;
}
