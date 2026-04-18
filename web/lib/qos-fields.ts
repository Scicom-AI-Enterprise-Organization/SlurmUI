export const QOS_FIELDS = [
  "Priority",
  "MaxJobsPU",
  "MaxSubmitPU",
  "MaxWall",
  "MaxTRESPU",
  "MaxTRESPJ",
  "GrpTRES",
  "GrpJobs",
  "Flags",
] as const;

export type QosField = typeof QOS_FIELDS[number];
