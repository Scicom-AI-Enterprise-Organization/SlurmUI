import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import {
  BrainCircuit,
  BarChart3,
  Code2,
  FlaskConical,
  LineChart,
  Terminal,
} from "lucide-react";

interface App {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: React.ElementType;
  tags: string[];
}

const APPS: App[] = [
  {
    id: "jupyter",
    name: "Jupyter Notebook",
    description: "Interactive Python environment for data science, ML, and scientific computing.",
    category: "Data Science",
    icon: BrainCircuit,
    tags: ["Python", "ML", "GPU"],
  },
  {
    id: "rstudio",
    name: "RStudio",
    description: "Integrated development environment for R statistical computing and graphics.",
    category: "Statistics",
    icon: BarChart3,
    tags: ["R", "Statistics"],
  },
  {
    id: "vscode",
    name: "VS Code Server",
    description: "Full VS Code in the browser — edit, run, and debug code on the cluster.",
    category: "Development",
    icon: Code2,
    tags: ["IDE", "Python", "GPU"],
  },
  {
    id: "matlab",
    name: "MATLAB",
    description: "Numerical computing environment for algorithm development and data analysis.",
    category: "Engineering",
    icon: FlaskConical,
    tags: ["MATLAB", "GPU"],
  },
  {
    id: "tensorboard",
    name: "TensorBoard",
    description: "Visualize ML training metrics, model graphs, and embeddings in real time.",
    category: "ML Tools",
    icon: LineChart,
    tags: ["ML", "Visualization"],
  },
  {
    id: "terminal",
    name: "Interactive Shell",
    description: "Request an interactive Slurm allocation and drop into a shell on a compute node.",
    category: "Utilities",
    icon: Terminal,
    tags: ["Shell", "GPU"],
  },
];

export default function AppsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Apps</h1>
        <p className="text-muted-foreground">
          Launch interactive sessions on compute clusters
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {APPS.map((app) => {
          const Icon = app.icon;
          return (
            <Card key={app.id} className="flex flex-col">
              <CardHeader className="flex flex-row items-start gap-4 space-y-0 pb-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <CardTitle className="text-base">{app.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">{app.category}</p>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <p className="text-sm text-muted-foreground">{app.description}</p>
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-1">
                    {app.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <Link href="/clusters">
                    <Button className="w-full" size="sm">
                      Launch on Cluster
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
