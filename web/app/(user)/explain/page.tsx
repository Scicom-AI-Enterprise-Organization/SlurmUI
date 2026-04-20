"use client";

import { useEffect, useState } from "react";

interface Section {
  id: string;
  title: string;
}

const sections: Section[] = [
  { id: "what", title: "What is Slurm?" },
  { id: "architecture", title: "Architecture" },
  { id: "nodes", title: "Nodes" },
  { id: "partitions", title: "Partitions" },
  { id: "jobs", title: "Jobs & States" },
  { id: "sbatch", title: "sbatch — submit a job" },
  { id: "squeue", title: "squeue — queue state" },
  { id: "scontrol", title: "scontrol — control & inspect" },
  { id: "sacct", title: "sacct — accounting history" },
  { id: "sinfo", title: "sinfo — node/partition state" },
  { id: "scancel", title: "scancel — cancel a job" },
  { id: "srun", title: "srun — run commands across allocated nodes" },
  { id: "gres", title: "GRES & GPUs" },
  { id: "accounting", title: "Accounting (slurmdbd)" },
  { id: "munge", title: "munge (auth)" },
  { id: "aura-map", title: "SlurmUI ↔ Slurm mapping" },
];

export default function ExplainPage() {
  const [active, setActive] = useState<string>("what");

  useEffect(() => {
    const scrollEl = document.querySelector("main");
    if (!scrollEl) return;

    const onScroll = () => {
      // Offset by the scroll container's top so the "active" section lines up
      // with where the text actually appears on screen, not the document origin.
      const containerTop = scrollEl.getBoundingClientRect().top;
      const threshold = 140; // rough allowance for sticky nav + breathing room
      let current = sections[0].id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top - containerTop;
        if (top <= threshold) current = s.id;
      }
      setActive(current);
    };

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    // Run once on mount so the initial highlight is right.
    onScroll();
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Learn Slurm</h1>
        <p className="text-muted-foreground">
          A practical tour of the concepts and commands you&apos;ll see in SlurmUI.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <nav className="hidden md:block text-sm sticky top-4 self-start">
          <ul className="space-y-1">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className={`block rounded px-3 py-1.5 transition-colors ${
                    active === s.id
                      ? "bg-muted text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="space-y-10">
          <Section id="what" title="What is Slurm?">
            <p>
              <b>Slurm</b> (Simple Linux Utility for Resource Management) is the
              scheduler that decides <i>which job runs on which node, when, and
              with how many CPUs/GPUs/RAM</i>. You describe what your job needs
              in a batch script, submit it with <Code>sbatch</Code>, and Slurm
              queues it, finds a fit, and runs it.
            </p>
            <p>
              Think of it as a queue manager for a pool of shared machines.
              Without it, users would step on each other&apos;s GPUs and fight
              over CPU cores.
            </p>
          </Section>

          <Section id="architecture" title="Architecture">
            <p>A Slurm cluster has a few daemons working together:</p>
            <table className="w-full text-sm border-collapse">
              <tbody>
                <Row k="slurmctld" v="The brain. Runs on the controller node. Accepts job submissions, makes scheduling decisions." />
                <Row k="slurmd" v="Agent on each compute node. Launches job steps, reports node health back to slurmctld." />
                <Row k="slurmdbd" v="Optional accounting daemon. Stores job history, user accounts, fair-share data in MariaDB. Without it, sacct and quotas don't work." />
                <Row k="munge" v="Authentication layer. A shared /etc/munge/munge.key on every node lets slurmctld/slurmd/slurmdbd trust each other." />
              </tbody>
            </table>
            <Pre>{`┌──────────────┐    munge     ┌──────────────┐
│  Controller  │◀────────────▶│   Worker 1   │   slurmd
│  slurmctld   │              │   slurmd     │
│  slurmdbd    │              └──────────────┘
└──────▲───────┘              ┌──────────────┐
       │ sbatch/scontrol      │   Worker 2   │   slurmd
       │                      │   slurmd     │
   user shell                 └──────────────┘`}</Pre>
          </Section>

          <Section id="nodes" title="Nodes">
            <p>
              A <b>node</b> is a physical or virtual machine that can run job
              steps. Each node has declared resources in{" "}
              <Code>slurm.conf</Code>: <Code>CPUs</Code>, <Code>RealMemory</Code>,{" "}
              <Code>Gres=gpu:N</Code>, etc. <b>slurmd</b> on the node reports
              back its real state; if the self-report disagrees with the config,
              Slurm may drain it.
            </p>
            <p>Node states you&apos;ll see in SlurmUI:</p>
            <table className="w-full text-sm border-collapse">
              <tbody>
                <Row k="idle" v="Healthy, no jobs running — ready." />
                <Row k="alloc / mixed" v="One or more jobs using some/all resources." />
                <Row k="drain" v="Admin or Slurm marked it unavailable for new jobs. Existing jobs keep running." />
                <Row k="down" v="Unreachable or failing health checks." />
                <Row k="fail / invalid_reg" v="Self-reported specs disagree with slurm.conf — node refuses to register." />
                <Row k="future" v="Placeholder — not yet configured/available." />
              </tbody>
            </table>
          </Section>

          <Section id="partitions" title="Partitions">
            <p>
              A <b>partition</b> is a named queue of nodes with its own rules.
              When you submit a job, you pick a partition. Admins define them
              in <Code>slurm.conf</Code> to group hardware or enforce policy.
            </p>
            <Pre>{`PartitionName=gpu   Nodes=node01,node02  Default=YES  MaxTime=INFINITE  State=UP
PartitionName=cpu   Nodes=node03         MaxTime=4:00:00   State=UP
PartitionName=debug Nodes=ALL            MaxTime=00:10:00  Priority=10 State=UP`}</Pre>
            <p>
              A node can live in <i>multiple</i> partitions. Without
              <Code>--partition=NAME</Code>, jobs land in the one marked
              <Code>Default=YES</Code>.
            </p>
          </Section>

          <Section id="jobs" title="Jobs & States">
            <p>A job flows through these states:</p>
            <Pre>{`PENDING  → waiting for resources / priority / dependency
RUNNING  → allocated and executing
COMPLETED → finished, exit code 0
FAILED    → exited non-zero, or OOM, or node crash
CANCELLED → scancel'd by user or admin
TIMEOUT   → exceeded --time limit
NODE_FAIL → node died mid-run`}</Pre>
            <p>
              Why a job is PENDING is in the <Code>Reason</Code> field shown by{" "}
              <Code>squeue</Code> or <Code>scontrol show job</Code>. Common
              reasons:
            </p>
            <table className="w-full text-sm border-collapse">
              <tbody>
                <Row k="Resources" v="Asked for more than what's free right now. Wait." />
                <Row k="Priority" v="Higher-priority jobs ahead of you." />
                <Row k="PartitionNodeLimit" v="Asked for more nodes than the partition has." />
                <Row k="ReqNodeNotAvail" v="Specific node(s) you asked for are down/drain." />
                <Row k="InvalidAccount" v="Accounting enforced but your user has no sacctmgr account." />
                <Row k="QOSMaxJobsPerUserLimit" v="Hit a per-user concurrent-job cap." />
              </tbody>
            </table>
          </Section>

          <Section id="sbatch" title="sbatch — submit a job">
            <p>
              You submit a <b>batch script</b>. Lines starting with{" "}
              <Code>#SBATCH</Code> are directives Slurm reads before running
              your shell code.
            </p>
            <Pre>{`#!/bin/bash
#SBATCH --job-name=train
#SBATCH --partition=gpu
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --gres=gpu:2
#SBATCH --mem=64G
#SBATCH --time=1-00:00:00      # 1 day
#SBATCH --output=train-%j.out  # %j = job id
#SBATCH --chdir=/mnt/shared    # run from here, outputs land here

source /opt/aura-venv/bin/activate
python train.py --epochs 100`}</Pre>
            <p>Common flags:</p>
            <table className="w-full text-sm border-collapse">
              <tbody>
                <Row k="--nodes=N" v="Number of nodes to allocate." />
                <Row k="--ntasks=N" v="Number of processes to launch (across all nodes)." />
                <Row k="--ntasks-per-node=N" v="Split tasks evenly across nodes." />
                <Row k="--cpus-per-task=N" v="CPU cores per task." />
                <Row k="--gres=gpu:N" v="GPUs per node." />
                <Row k="--mem=16G or --mem-per-cpu=2G" v="Memory per node / per cpu." />
                <Row k="--time=HH:MM:SS or D-HH:MM:SS" v="Hard wallclock limit. 0 = unlimited." />
                <Row k="--account=NAME" v="Charge this sacctmgr account (when accounting on)." />
                <Row k="--dependency=afterok:JOBID" v="Start only after another job succeeds." />
              </tbody>
            </table>
            <p>
              Submit & see the returned job id:
            </p>
            <Pre>{`$ sbatch train.sh
Submitted batch job 12345`}</Pre>
          </Section>

          <Section id="squeue" title="squeue — queue state">
            <Pre>{`$ squeue
JOBID PARTITION     NAME     USER ST       TIME  NODES NODELIST(REASON)
12345       gpu    train    alice  R       2:13      1 node01
12346       gpu    vllm       bob PD       0:00      2 (Resources)`}</Pre>
            <p>
              <Code>ST</Code> is short state: <Code>PD</Code>=pending,{" "}
              <Code>R</Code>=running, <Code>CG</Code>=completing. Useful flags:
            </p>
            <Pre>{`squeue -u alice           # just alice's jobs
squeue -p gpu             # just the gpu partition
squeue -j 12345           # one specific job
squeue -o '%.18i %.2t %.10M %R'  # custom columns`}</Pre>
          </Section>

          <Section id="scontrol" title="scontrol — control & inspect">
            <p>
              Admin-flavored inspection and manipulation. Works on live state
              only — completed jobs age out (default ~5 min after finish).
            </p>
            <Pre>{`scontrol show job 12345           # everything Slurm knows about this job
scontrol show node node01         # node config + live status
scontrol show partition gpu       # partition rules + member list
scontrol update NodeName=node01 State=RESUME    # un-drain a node
scontrol update NodeName=node01 State=DOWN Reason="rma"
scontrol hold 12345               # freeze a pending job
scontrol release 12345            # un-freeze
scontrol requeue 12345            # kill and re-queue`}</Pre>
          </Section>

          <Section id="sacct" title="sacct — accounting history">
            <p>
              Historical record of jobs (including completed). Requires{" "}
              <b>slurmdbd</b> running. If accounting is disabled, you&apos;ll see{" "}
              <i>&ldquo;Slurm accounting storage is disabled&rdquo;</i> — enable
              it via <b>Cluster → Configuration → Slurm Accounting → Enable</b>.
            </p>
            <Pre>{`sacct -j 12345                           # a specific job
sacct -u alice --starttime=2026-04-01    # all of alice's jobs this month
sacct -j 12345 -o JobID,State,ExitCode,Elapsed,MaxRSS,MaxVMSize
sacct --format=JobID,JobName,Partition,State,Elapsed,ReqTRES%-40`}</Pre>
          </Section>

          <Section id="sinfo" title="sinfo — node/partition state">
            <Pre>{`$ sinfo
PARTITION AVAIL  TIMELIMIT  NODES  STATE NODELIST
gpu*         up   infinite      2   idle node[01-02]
cpu          up   4:00:00       1    mix node03

$ sinfo -N -p gpu -o "%n %t %c %m %G"   # per-node view
HOSTNAMES         STATE CPUS  MEMORY GRES
node01            idle    56  173046 gpu:2
node02            idle    56  173046 gpu:2`}</Pre>
          </Section>

          <Section id="scancel" title="scancel — cancel a job">
            <Pre>{`scancel 12345                  # one job
scancel -u alice               # all of alice's jobs
scancel --state=PENDING        # clear your pending queue
scancel --name=train           # by --job-name`}</Pre>
          </Section>

          <Section id="srun" title="srun — run commands across allocated nodes">
            <p>
              Inside a batch script, <Code>srun</Code> launches <i>job steps</i>:
              one copy of the command per task, on the right node, with the
              right environment. Critical for multi-node jobs.
            </p>
            <Pre>{`#SBATCH --nodes=4
#SBATCH --ntasks-per-node=1

srun hostname          # prints 4 hostnames — one per allocated node
srun --ntasks=8 python worker.py   # 8 ranks, spread across nodes`}</Pre>
            <p>
              Without <Code>srun</Code>, your script&apos;s commands run only
              on the <i>first</i> allocated node. Multi-node workloads always
              wrap their launcher (e.g. <Code>torchrun</Code>) inside{" "}
              <Code>srun</Code>.
            </p>
          </Section>

          <Section id="gres" title="GRES & GPUs">
            <p>
              <b>Generic Resources (GRES)</b> is how Slurm tracks non-CPU
              hardware like GPUs. In <Code>slurm.conf</Code>:
            </p>
            <Pre>{`GresTypes=gpu
NodeName=node01 CPUs=56 RealMemory=173046 Gres=gpu:2 State=UNKNOWN`}</Pre>
            <p>Plus a <Code>/etc/slurm/gres.conf</Code> on each GPU node:</p>
            <Pre>{`Name=gpu File=/dev/nvidia0
Name=gpu File=/dev/nvidia1`}</Pre>
            <p>Request them from a job:</p>
            <Pre>{`#SBATCH --gres=gpu:2           # 2 GPUs on this node
#SBATCH --gres=gpu:a100:2      # specific model (if typed)

# Inside the job, Slurm sets CUDA_VISIBLE_DEVICES correctly.
echo $CUDA_VISIBLE_DEVICES     # e.g. "0,1"`}</Pre>
          </Section>

          <Section id="accounting" title="Accounting (slurmdbd)">
            <p>
              When you enable accounting, Slurm writes every job to a MariaDB
              database via <Code>slurmdbd</Code> and uses{" "}
              <Code>sacctmgr</Code> to manage <i>associations</i>: tuples of
              (cluster, account, user, partition) with limits attached.
            </p>
            <Pre>{`sacctmgr -i add cluster slurmui
sacctmgr -i add account research Description="..." Organization=SlurmUI
sacctmgr -i add user alice Account=research DefaultAccount=research
sacctmgr modify user alice set MaxJobs=10 MaxWall=1-00:00:00

sacctmgr -s list user             # show associations
sacctmgr show runaway             # job records that lost sync`}</Pre>
            <p>
              Without this, <Code>--account=</Code> is ignored and you get
              no history/quotas. SlurmUI starts clusters with accounting{" "}
              <i>off</i> by default; turn it on from the cluster&apos;s
              Configuration tab.
            </p>
          </Section>

          <Section id="munge" title="munge (auth)">
            <p>
              Slurm daemons authenticate to each other using{" "}
              <Code>munge</Code>. Every node in the cluster must have an
              identical <Code>/etc/munge/munge.key</Code> owned by the{" "}
              <Code>munge</Code> user (mode <Code>0400</Code>). SlurmUI copies the
              key from the controller to new nodes automatically during Add
              Node; if you see <i>&ldquo;auth_g_verify&rdquo;</i> errors, the
              key got out of sync.
            </p>
          </Section>

          <Section id="aura-map" title="SlurmUI ↔ Slurm mapping">
            <table className="w-full text-sm border-collapse">
              <tbody>
                <Row k="Settings → Nodes" v="Edits NodeName lines in slurm.conf, installs slurmd on workers, copies munge key." />
                <Row k="Settings → Partitions" v="Rewrites PartitionName lines. Apply to Cluster restarts slurmctld." />
                <Row k="Settings → Users" v="Linux useradd + NFS home + sacctmgr add user (if accounting is on)." />
                <Row k="Settings → Packages" v="apt install on every node." />
                <Row k="Settings → Python" v="uv venv (shared on storage, or per-node locally)." />
                <Row k="Settings → Storages" v="NFS / S3fs mounts deployed to each node via /etc/fstab." />
                <Row k="Settings → Configuration → Slurm Accounting" v="Toggles AccountingStorageType between slurmdbd and none, starts/stops slurmdbd + MariaDB." />
                <Row k="Jobs page → Slurm Info tab" v="Live scontrol / squeue / sinfo / sacct output for a job." />
              </tbody>
            </table>
          </Section>
        </article>
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3">
      <h2 className="text-xl font-semibold border-b pb-1">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed">{children}</div>
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-5">
      {children}
    </pre>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-2 pr-4 align-top font-mono text-xs whitespace-nowrap">{k}</td>
      <td className="py-2 text-muted-foreground">{v}</td>
    </tr>
  );
}
