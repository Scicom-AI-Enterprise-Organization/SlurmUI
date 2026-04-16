"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";

interface AuditLogEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  userId: string | null;
  userEmail: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface AuditLogTableProps {
  logs: AuditLogEntry[];
  pagination: Pagination;
  filters: { action: string; entity: string; search: string };
  availableActions: string[];
  availableEntities: string[];
}

const ACTION_COLORS: Record<string, string> = {
  create: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  delete: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  update: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  deploy: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  verify: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  teardown: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  provision: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  deprovision: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
};

function getActionColor(action: string): string {
  const verb = action.split(".")[1] ?? action;
  return ACTION_COLORS[verb] ?? "bg-muted text-muted-foreground";
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  // Use UTC-based formatting to avoid hydration mismatch
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const day = d.getUTCDate();
  const h = d.getUTCHours().toString().padStart(2, "0");
  const m = d.getUTCMinutes().toString().padStart(2, "0");
  const s = d.getUTCSeconds().toString().padStart(2, "0");
  return `${month} ${day}, ${h}:${m}:${s}`;
}

const ALL_VALUE = "__all__";

export function AuditLogTable({
  logs,
  pagination,
  filters,
  availableActions,
  availableEntities,
}: AuditLogTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchInput, setSearchInput] = useState(filters.search);

  const updateFilters = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    }
    params.delete("page");
    router.push(`/admin/audit-log?${params.toString()}`);
  };

  const goToPage = (page: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(page));
    router.push(`/admin/audit-log?${params.toString()}`);
  };

  const clearFilters = () => {
    setSearchInput("");
    router.push("/admin/audit-log");
  };

  const hasFilters = filters.action || filters.entity || filters.search;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search actions, users, entities..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") updateFilters({ search: searchInput });
            }}
            className="pl-9"
          />
        </div>
        <Select
          value={filters.action || ALL_VALUE}
          onValueChange={(v) => updateFilters({ action: v === ALL_VALUE ? "" : v })}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All actions</SelectItem>
            {availableActions.map((a) => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.entity || ALL_VALUE}
          onValueChange={(v) => updateFilters({ entity: v === ALL_VALUE ? "" : v })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All entities" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_VALUE}>All entities</SelectItem>
            {availableEntities.map((e) => (
              <SelectItem key={e} value={e}>{e}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[160px]">Time</TableHead>
              <TableHead className="w-[180px]">Action</TableHead>
              <TableHead className="w-[100px]">Entity</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  {hasFilters ? "No audit logs match your filters" : "No audit logs yet"}
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatTime(log.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={getActionColor(log.action)}>
                      {log.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{log.entity}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {log.userEmail ?? "system"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate">
                    {log.metadata ? formatMetadata(log.metadata) : log.entityId ?? ""}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {(pagination.page - 1) * pagination.limit + 1}
            {" "}-{" "}
            {Math.min(pagination.page * pagination.limit, pagination.total)}
            {" "}of {pagination.total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => goToPage(pagination.page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => goToPage(pagination.page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatMetadata(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value !== null && value !== undefined && value !== "") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join(", ");
}
