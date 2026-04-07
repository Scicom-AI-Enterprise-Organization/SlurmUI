interface FreeIPASession {
  cookie: string;
  expiresAt: number;
}

let session: FreeIPASession | null = null;

async function getSession(): Promise<string> {
  if (session && Date.now() < session.expiresAt) {
    return session.cookie;
  }

  const loginUrl = `${process.env.FREEIPA_URL}/session/login_password`;
  const body = new URLSearchParams({
    user: process.env.FREEIPA_USER!,
    password: process.env.FREEIPA_PASSWORD!,
  });

  const res = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`FreeIPA login failed: ${res.status} ${res.statusText}`);
  }

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("FreeIPA login did not return session cookie");
  }

  // Extract ipa_session cookie
  const match = setCookie.match(/ipa_session=([^;]+)/);
  if (!match) {
    throw new Error("Could not parse ipa_session cookie");
  }

  session = {
    cookie: `ipa_session=${match[1]}`,
    expiresAt: Date.now() + 20 * 60 * 1000, // 20 minutes
  };

  return session.cookie;
}

async function rpc(method: string, args: unknown[] = [], options: Record<string, unknown> = {}): Promise<unknown> {
  const cookie = await getSession();
  const url = `${process.env.FREEIPA_URL}/session/json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Referer: process.env.FREEIPA_URL!,
    },
    body: JSON.stringify({
      method,
      params: [args, options],
      id: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`FreeIPA RPC error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  if (data.error) {
    // error code 4002 = already exists (DuplicateEntry)
    if (data.error.code === 4002) {
      return data.error;
    }
    throw new Error(`FreeIPA error: ${data.error.message} (code ${data.error.code})`);
  }

  return data.result;
}

export interface CreateUserResult {
  uid: number;
  gid: number;
}

/**
 * Create a user in FreeIPA, returning their uid and gid.
 * If user already exists, fetches existing uid/gid.
 */
export async function createFreeIPAUser(
  username: string,
  firstName: string,
  lastName: string,
  email: string
): Promise<CreateUserResult> {
  try {
    const result = await rpc("user_add", [username], {
      givenname: firstName,
      sn: lastName,
      mail: email,
      // Let FreeIPA auto-assign uid/gid
    });

    // Extract uid/gid from result
    const userData = result as { result: { uidnumber: [string]; gidnumber: [string] } };
    return {
      uid: parseInt(userData.result.uidnumber[0], 10),
      gid: parseInt(userData.result.gidnumber[0], 10),
    };
  } catch (error) {
    // If user exists, fetch their info
    const showResult = await rpc("user_show", [username]);
    const userData = showResult as { result: { uidnumber: [string]; gidnumber: [string] } };
    return {
      uid: parseInt(userData.result.uidnumber[0], 10),
      gid: parseInt(userData.result.gidnumber[0], 10),
    };
  }
}

/**
 * Add a user to a group in FreeIPA.
 */
export async function addUserToGroup(username: string, groupName: string): Promise<void> {
  await rpc("group_add_member", [groupName], {
    user: [username],
  });
}
