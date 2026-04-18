"use client";

import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { UsersTab } from "@/components/cluster/users-tab";
import { AccountTreeTab } from "@/components/cluster/account-tree-tab";
import { RequiresBootstrap } from "@/components/cluster/requires-nodes";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

const VALID = new Set(["users", "accounts"]);

export default function UsersPage() {
  const params = useParams();
  const id = params.id as string;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const qTab = searchParams.get("tab");
  const tab = qTab && VALID.has(qTab) ? qTab : "users";

  const setTab = (v: string) => {
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    if (v === "users") sp.delete("tab");
    else sp.set("tab", v);
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/clusters/${id}`)
      .then((r) => r.json())
      .then((c) => setStatus(c.status ?? "UNKNOWN"))
      .catch(() => setStatus("UNKNOWN"));
  }, [id]);

  if (status === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (status !== "ACTIVE") return <RequiresBootstrap />;

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="users">Users</TabsTrigger>
        <TabsTrigger value="accounts">Account tree</TabsTrigger>
      </TabsList>
      <TabsContent value="users" className="mt-4">
        <UsersTab clusterId={id} />
      </TabsContent>
      <TabsContent value="accounts" className="mt-4">
        <AccountTreeTab clusterId={id} />
      </TabsContent>
    </Tabs>
  );
}
