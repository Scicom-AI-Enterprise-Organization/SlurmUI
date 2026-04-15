"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, Loader2, XCircle } from "lucide-react";

// xterm.js is browser-only — dynamic import prevents SSR issues
const TerminalView = dynamic(() => import("@/components/apps/terminal-view"), { ssr: false });

interface AppSession {
  id: string;
  type: string;
  partition: string;
  status: string;
  accessUrl: string | null;
  createdAt: string;
}

export default function SessionPage() {
  const params = useParams();
  const router = useRouter();
  const clusterId = params.id as string;
  const sessionId = params.sessionId as string;

  const [session, setSession] = useState<AppSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [killing, setKilling] = useState(false);

  useEffect(() => {
    fetch(`/api/clusters/${clusterId}/apps/${sessionId}`)
      .then((r) => r.json())
      .then(setSession)
      .catch(() => toast.error("Session not found"))
      .finally(() => setLoading(false));
  }, [clusterId, sessionId]);

  const kill = async () => {
    setKilling(true);
    await fetch(`/api/clusters/${clusterId}/apps/${sessionId}`, { method: "DELETE" }).catch(() => {});
    router.push(`/clusters/${clusterId}/apps`);
  };

  if (loading) return <p className="text-center text-muted-foreground py-12">Loading...</p>;
  if (!session) return <p className="text-center text-muted-foreground py-12">Session not found.</p>;

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] space-y-3">
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push(`/clusters/${clusterId}/apps`)}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Apps
          </Button>
          <h1 className="text-xl font-bold capitalize">{session.type}</h1>
          <Badge variant={session.status === "RUNNING" ? "default" : "secondary"}>
            {session.status}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {session.partition}
          </span>
        </div>
        <Button variant="destructive" size="sm" onClick={kill} disabled={killing}>
          {killing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
          Terminate
        </Button>
      </div>

      {session.type === "jupyter" ? (
        <JupyterPanel clusterId={clusterId} sessionId={sessionId} session={session} setSession={setSession} />
      ) : (
        <TerminalView clusterId={clusterId} sessionId={sessionId} />
      )}
    </div>
  );
}

function JupyterPanel({
  clusterId, sessionId, session, setSession,
}: {
  clusterId: string;
  sessionId: string;
  session: AppSession;
  setSession: (s: AppSession) => void;
}) {
  const [waiting, setWaiting] = useState(!session.accessUrl);
  const [note, setNote] = useState("");
  const evtRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (session.accessUrl) return; // already have URL

    const evtSource = new EventSource(`/api/clusters/${clusterId}/apps/${sessionId}/stream`);
    evtRef.current = evtSource;

    evtSource.onmessage = (e) => {
      const evt = JSON.parse(e.data);
      if (evt.type === "jupyter_ready") {
        setSession({ ...session, status: "RUNNING", accessUrl: evt.access_url });
        setNote(evt.note ?? "");
        setWaiting(false);
        evtSource.close();
      } else if (evt.type === "exit") {
        setSession({ ...session, status: "STOPPED" });
        setWaiting(false);
        evtSource.close();
      }
    };
    evtSource.onerror = () => {
      setWaiting(false);
      evtSource.close();
    };

    return () => evtSource.close();
  }, []);

  if (waiting) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center space-y-3">
          <Loader2 className="h-10 w-10 animate-spin mx-auto text-muted-foreground" />
          <p className="text-muted-foreground">Starting Jupyter Notebook...</p>
          <p className="text-xs text-muted-foreground">This may take 30–60 seconds.</p>
        </div>
      </div>
    );
  }

  if (!session.accessUrl) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-muted-foreground">
          <p>Session ended before Jupyter could start.</p>
          <p className="text-sm">Check that <code>jupyter</code> is installed on the compute node and that port 8888 is available.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Jupyter Notebook Ready</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3 rounded-md bg-muted p-3 font-mono text-sm break-all">
          {session.accessUrl}
        </div>
        <a href={session.accessUrl} target="_blank" rel="noopener noreferrer">
          <Button>
            <ExternalLink className="mr-2 h-4 w-4" /> Open Jupyter
          </Button>
        </a>
        {note && (
          <p className="text-xs text-muted-foreground">
            {note}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
