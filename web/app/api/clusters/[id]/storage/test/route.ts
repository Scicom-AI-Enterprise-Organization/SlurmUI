import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sshExecScript } from "@/lib/ssh-exec";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/clusters/[id]/storage/test — test NFS/S3 connectivity via SSH
export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user || (session.user as any).role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cluster = await prisma.cluster.findUnique({
    where: { id },
    include: { sshKey: true },
  });
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 });
  if (!cluster.sshKey) return NextResponse.json({ error: "No SSH key" }, { status: 412 });

  const body = await req.json();
  const { type, nfsServer, nfsPath, s3Bucket, s3Endpoint, s3AccessKey, s3SecretKey, s3Region } = body;

  const target = {
    host: cluster.controllerHost,
    user: cluster.sshUser,
    port: cluster.sshPort,
    privateKey: cluster.sshKey.privateKey,
    bastion: cluster.sshBastion,
  };

  let script: string;
  const marker = `__AURA_TEST_${Date.now()}__`;

  if (type === "nfs") {
    script = `#!/bin/bash
echo "${marker}_START"

# Simple reachability check: ping (ICMP) then fallback to TCP port 2049
if ping -c 2 -W 3 ${nfsServer} > /dev/null 2>&1; then
  echo "RESULT_OK"
elif (echo > /dev/tcp/${nfsServer}/2049) 2>/dev/null; then
  echo "RESULT_OK"
else
  echo "RESULT_FAIL"
  echo "NFS server ${nfsServer} is not reachable"
fi

echo "${marker}_END"
`;
  } else {
    // S3: validate credentials by making a signed HEAD request to the bucket.
    // Use python's hmac/hashlib which is always available, no extra packages needed.
    const region = s3Region || "us-east-1";
    const endpoint = s3Endpoint || `https://s3.${region}.amazonaws.com`;
    script = `#!/bin/bash
echo "${marker}_START"

python3 -W ignore - <<'PYEOF'
import hashlib, hmac, datetime, urllib.request, urllib.error, ssl, sys, warnings
warnings.filterwarnings("ignore")

access_key = "${s3AccessKey}"
secret_key = "${s3SecretKey}"
region = "${region}"
bucket = "${s3Bucket}"
endpoint = "${endpoint}".rstrip("/")

# Parse endpoint
if endpoint.startswith("https://"):
    host = endpoint[8:]
    scheme = "https"
elif endpoint.startswith("http://"):
    host = endpoint[7:]
    scheme = "http"
else:
    host = endpoint
    scheme = "https"

# Determine if using path-style (custom endpoint) or virtual-hosted style (AWS)
is_aws = "amazonaws.com" in host
if is_aws:
    url_host = f"{bucket}.{host}"
    canonical_uri = "/"
else:
    url_host = host
    canonical_uri = f"/{bucket}"

url = f"{scheme}://{url_host}{canonical_uri}"
method = "HEAD"

now = datetime.datetime.utcnow()
amz_date = now.strftime("%Y%m%dT%H%M%SZ")
date_stamp = now.strftime("%Y%m%d")
# Avoid datetime.utcnow() deprecation
now = datetime.datetime.now(datetime.timezone.utc) if hasattr(datetime, 'timezone') else now

# Canonical request
payload_hash = hashlib.sha256(b"").hexdigest()
canonical_headers = f"host:{url_host}\\nx-amz-content-sha256:{payload_hash}\\nx-amz-date:{amz_date}\\n"
signed_headers = "host;x-amz-content-sha256;x-amz-date"
canonical_request = f"{method}\\n{canonical_uri}\\n\\n{canonical_headers}\\n{signed_headers}\\n{payload_hash}"

# String to sign
algorithm = "AWS4-HMAC-SHA256"
credential_scope = f"{date_stamp}/{region}/s3/aws4_request"
string_to_sign = f"{algorithm}\\n{amz_date}\\n{credential_scope}\\n{hashlib.sha256(canonical_request.encode()).hexdigest()}"

# Signing key
def sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()

k_date = sign(("AWS4" + secret_key).encode(), date_stamp)
k_region = sign(k_date, region)
k_service = sign(k_region, "s3")
k_signing = sign(k_service, "aws4_request")
signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()

auth_header = f"{algorithm} Credential={access_key}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}"

req = urllib.request.Request(url, method=method)
req.add_header("Host", url_host)
req.add_header("x-amz-date", amz_date)
req.add_header("x-amz-content-sha256", payload_hash)
req.add_header("Authorization", auth_header)

ctx = ssl.create_default_context()

try:
    resp = urllib.request.urlopen(req, context=ctx, timeout=10)
    print("RESULT_OK")
except urllib.error.HTTPError as e:
    if e.code == 200:
        print("RESULT_OK")
    elif e.code == 403:
        print("RESULT_FAIL")
        print(f"Access denied (403): invalid credentials or no permission on bucket '{bucket}'")
    elif e.code == 404:
        print("RESULT_FAIL")
        print(f"Bucket '{bucket}' not found (404)")
    elif e.code == 301 or e.code == 307:
        print("RESULT_FAIL")
        print(f"Wrong region: server returned {e.code}. Check the Region field.")
    else:
        print("RESULT_FAIL")
        print(f"HTTP {e.code}: {e.reason}")
except urllib.error.URLError as e:
    print("RESULT_FAIL")
    print(f"Cannot reach endpoint: {e.reason}")
except Exception as e:
    print("RESULT_FAIL")
    print(f"Error: {e}")
PYEOF

echo "${marker}_END"
`;
  }

  const rawChunks: string[] = [];
  await new Promise<void>((resolve) => {
    sshExecScript(target, script, {
      onStream: (line) => rawChunks.push(line),
      onComplete: () => resolve(),
    });
  });

  const full = rawChunks.join("\n");
  const startIdx = full.indexOf(`${marker}_START`);
  const endIdx = full.indexOf(`${marker}_END`);

  if (startIdx === -1 || endIdx === -1) {
    return NextResponse.json({ success: false, error: "Test script did not complete. Check cluster connectivity." });
  }

  const body_output = full.slice(startIdx + `${marker}_START`.length, endIdx).replace(/\r/g, "").trim();
  const lines = body_output.split("\n").filter(Boolean);

  // Find the RESULT_OK or RESULT_FAIL line (may be preceded by warnings/noise)
  const resultIdx = lines.findIndex((l) => l === "RESULT_OK" || l === "RESULT_FAIL");

  if (resultIdx !== -1 && lines[resultIdx] === "RESULT_OK") {
    return NextResponse.json({
      success: true,
      message: type === "nfs"
        ? `NFS server ${nfsServer} is reachable`
        : `S3 bucket "${s3Bucket}" is accessible`,
    });
  }

  if (resultIdx !== -1 && lines[resultIdx] === "RESULT_FAIL") {
    const detail = lines.slice(resultIdx + 1).join("\n");
    return NextResponse.json({
      success: false,
      error: detail || "Test failed",
    });
  }

  return NextResponse.json({
    success: false,
    error: `Unexpected output:\n${body_output.slice(0, 500)}`,
  });
}
