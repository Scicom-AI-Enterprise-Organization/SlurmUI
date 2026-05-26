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
  "passphrase",
  // Catches snake_case secret fields ending in `_pass` — e.g. the Slurm
  // accounting DB password we persist as `vault_slurmdbd_storage_pass`
  // after an Enable-Accounting run.
  "_pass",
  "token",
  "credential",
  "apikey",
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
    const obj = value as Record<string, unknown>;
    // Pattern used by cluster.config.os_environment (and anywhere else that
    // stores `{ key, value, secret }` entries): when `secret === true`, the
    // `value` field is the thing to mask regardless of its field name.
    const secretFlag = obj.secret === true;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (secretFlag && k === "value" && typeof v === "string" && v.length > 0) {
        out[k] = REDACTION_MASK;
      } else if (isSensitiveKey(k) && typeof v === "string" && v.length > 0) {
        out[k] = REDACTION_MASK;
      } else {
        out[k] = redactConfig(v);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Mask secret-bearing `export VAR=...` lines in a shell script before
 * returning it to a client. Needed for two cases:
 *   1. Historical Job.script rows that pre-date the secret-split fix in
 *      submit-job.ts — those still have `export MLFLOW_TRACKING_PASSWORD=...`
 *      and `export WANDB_API_KEY=...` literals inside the persisted script.
 *   2. User-written job scripts that happen to inline a secret-looking var.
 *
 * Matches three common shell export forms:
 *   export FOO=bar
 *   export FOO='bar'
 *   export FOO="bar"
 *
 * Plus the bare `FOO=bar` form (which Aura's preStartShell never emits but
 * cheap to handle for user scripts). VAR name match is case-insensitive
 * and uses the same SENSITIVE_KEY_HINTS list as redactConfig — so any
 * env var with "password" / "api_key" / "token" / "secret" / "_pass" in
 * its name gets masked.
 *
 * Idempotent: re-running on an already-masked script is a no-op.
 */
const SECRET_EXPORT_RE = new RegExp(
  String.raw`^(\s*(?:export\s+)?)([A-Z_][A-Z0-9_]*)(=)((?:'[^']*'|"[^"]*"|\S+))\s*$`,
  "i",
);

export function redactSecretsInScript(script: string): string {
  if (!script || typeof script !== "string") return script;
  return script
    .split("\n")
    .map((line) => {
      const m = line.match(SECRET_EXPORT_RE);
      if (!m) return line;
      const [, prefix, name, eq, value] = m;
      if (!isSensitiveKey(name)) return line;
      // Don't mask placeholders like "''" or empty values — nothing to leak.
      if (value === "''" || value === '""' || value === "") return line;
      // Preserve the original quoting style so the line still looks like
      // valid bash. The MASK is wrapped in the same quote character (or
      // single-quoted if the original was unquoted).
      const quote = value.startsWith('"') ? '"' : "'";
      return `${prefix}${name}${eq}${quote}${REDACTION_MASK}${quote}`;
    })
    .join("\n");
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
    const secretFlag = (incoming as Record<string, unknown>).secret === true;
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      if (secretFlag && k === "value" && v === REDACTION_MASK) {
        out[k] = storedObj[k] ?? "";
      } else if (isSensitiveKey(k) && v === REDACTION_MASK) {
        out[k] = storedObj[k] ?? "";
      } else {
        out[k] = unredactConfig(v, storedObj[k]);
      }
    }
    return out;
  }
  return incoming;
}
