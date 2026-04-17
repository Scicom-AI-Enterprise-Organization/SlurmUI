/**
 * Strip secret fields from cluster.config before sending to clients.
 *
 * SENSITIVE_KEYS is the list of config keys whose values must never leave the
 * server verbatim. They get replaced with a MASK sentinel; when the Config
 * editor POSTs changes, any field still equal to MASK is merged back from the
 * DB-stored value so the secret isn't clobbered.
 */

export const REDACTION_MASK = "********";

// Recursively walk an object and mask any key whose name contains one of these
// substrings (case-insensitive). Keeps it loose so future secret-bearing
// fields are automatically covered.
const SENSITIVE_KEY_HINTS = [
  "secretkey",
  "accesskey",
  "privatekey",
  "password",
  "passwd",
  "token",
  "credential",
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_HINTS.some((h) => lower.includes(h));
}

export function redactConfig<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(redactConfig) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k) && typeof v === "string" && v.length > 0) {
        out[k] = REDACTION_MASK;
      } else {
        out[k] = redactConfig(v);
      }
    }
    return out as T;
  }
  return value;
}

// Given an incoming config from the client, fill in any REDACTION_MASK values
// with the original secrets from `stored`. Preserves all other edits.
export function unredactConfig(incoming: unknown, stored: unknown): unknown {
  if (Array.isArray(incoming) && Array.isArray(stored)) {
    return incoming.map((item, i) => unredactConfig(item, stored[i]));
  }
  if (incoming && typeof incoming === "object" && stored && typeof stored === "object") {
    const out: Record<string, unknown> = {};
    const storedObj = stored as Record<string, unknown>;
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      if (isSensitiveKey(k) && v === REDACTION_MASK) {
        out[k] = storedObj[k] ?? "";
      } else {
        out[k] = unredactConfig(v, storedObj[k]);
      }
    }
    return out;
  }
  return incoming;
}
