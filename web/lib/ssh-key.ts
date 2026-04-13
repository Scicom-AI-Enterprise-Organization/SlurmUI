import { createPrivateKey, createPublicKey } from "crypto";

/**
 * Normalises a pasted private key string: strips surrounding whitespace,
 * normalises Windows line endings, and ensures a trailing newline.
 * Node.js crypto is strict about PEM / OpenSSH formatting.
 */
export function normaliseKey(raw: string): string {
  return raw
    .trim()
    .replace(/\r\n/g, "\n") // CRLF → LF
    .replace(/\r/g, "\n")   // stray CR → LF
    + "\n";                  // ensure trailing newline
}

/**
 * Derives the OpenSSH public key string from an OpenSSH or PEM private key.
 * Supports ed25519 keys (recommended: ssh-keygen -t ed25519 -C aura-cluster-key).
 * Throws a user-friendly error for unsupported key types.
 */
export function sshPublicKeyFromPrivate(privateKeyPem: string): string {
  const normalised = normaliseKey(privateKeyPem);
  let privKey;
  try {
    privKey = createPrivateKey(normalised);
  } catch (e: any) {
    throw new Error(
      `Could not parse private key: ${e?.message ?? "unknown error"}. ` +
      `Paste the full OpenSSH private key including the -----BEGIN/END----- lines.`
    );
  }

  const keyType = privKey.asymmetricKeyType;

  if (keyType === "ed25519") {
    const pubKey = createPublicKey(privKey);
    // SPKI DER for ed25519: last 32 bytes are the raw public key
    const spkiDer = pubKey.export({ type: "spki", format: "der" }) as Buffer;
    const rawKey = spkiDer.slice(-32);
    const typeBuf = Buffer.from("ssh-ed25519");
    const wire = Buffer.allocUnsafe(4 + typeBuf.length + 4 + rawKey.length);
    wire.writeUInt32BE(typeBuf.length, 0);
    typeBuf.copy(wire, 4);
    wire.writeUInt32BE(rawKey.length, 4 + typeBuf.length);
    rawKey.copy(wire, 4 + typeBuf.length + 4);
    return `ssh-ed25519 ${wire.toString("base64")} aura-cluster-key`;
  }

  throw new Error(
    `Key type "${keyType}" is not supported. Please generate an ed25519 key:\n  ssh-keygen -t ed25519 -C aura-cluster-key -f ~/.ssh/aura_cluster_key`
  );
}
