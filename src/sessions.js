import fs from "node:fs";

// Remembers which browser session belongs to which TAO login. The gateway sees every login go by (the login form is
// posted through it), so it notes the session cookies that login produced. Nothing else is needed to know, on every
// later request, who is asking.

const DAY_MS = 86_400_000;

// "a=1; b=2" -> ["a=1", "b=2"]
export function cookiePairs(header) {
  return String(header ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes("=") && pair.split("=")[1] !== "");
}

// The "name=value" of each cookie a response sets (Node gives set-cookie as an array).
export function setCookiePairs(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((line) => String(line).split(";")[0].trim()).filter((pair) => pair.includes("=") && !/=(deleted)?$/i.test(pair));
}

export class SessionStore {
  constructor({ file = null, ttlMs = DAY_MS, now = () => Date.now() } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map(); // cookie pair -> { login, at }
    this.load();
  }

  remember(pairs, login) {
    for (const pair of pairs) this.sessions.set(pair, { login, at: this.now() });
    this.save();
  }

  forget(pairs) {
    let changed = false;
    for (const pair of pairs) changed = this.sessions.delete(pair) || changed;
    if (changed) this.save();
  }

  // The login behind a request's cookies, or null when the gateway has not seen that session log in.
  find(cookieHeader) {
    for (const pair of cookiePairs(cookieHeader)) {
      const entry = this.sessions.get(pair);
      if (!entry) continue;
      if (this.now() - entry.at > this.ttlMs) {
        this.sessions.delete(pair);
        continue;
      }
      return entry.login;
    }
    return null;
  }

  prune() {
    for (const [pair, entry] of this.sessions) if (this.now() - entry.at > this.ttlMs) this.sessions.delete(pair);
  }

  load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [pair, entry] of Object.entries(saved)) this.sessions.set(pair, entry);
      this.prune();
    } catch {
      /* no file yet, or unreadable: start empty */
    }
  }

  // Kept on disk so a gateway restart doesn't sign everyone out. The file holds live session cookies: it is written
  // readable by the gateway's own user only.
  save() {
    if (!this.file) return;
    try {
      this.prune();
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
    } catch (error) {
      console.error(JSON.stringify({ event: "session_save_failed", error: String(error?.message ?? error) }));
    }
  }
}

// Who a TAO login is. Experts and learners are created by TopBrainer with predictable names (lib/tao/user-identity.ts).
export function classifyLogin(login, adminLogins = ["taoAdmin"]) {
  if (!login) return { kind: "anonymous", login: null };
  if (adminLogins.includes(login)) return { kind: "admin", login };
  const expert = /^tb_([0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12})_tao_author$/i.exec(login);
  if (expert) return { kind: "expert", login, expertId: expert[1].replace(/_/g, "-").toLowerCase() };
  if (/^tb_.+_tao_(learner|[A-Za-z0-9_-]{10})$/.test(login)) return { kind: "learner", login };
  return { kind: "other", login };
}

// The app calls TAO's REST interfaces with the admin's username and password in the request (HTTP Basic), not with a
// browser cookie. If the request names an admin account that way it is treated as that admin: TAO checks the password
// itself, so nothing is granted that TAO would not grant. Any other Basic login is not trusted here.
export function adminFromBasicAuth(header, adminLogins = ["taoAdmin"]) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(header ?? ""));
  if (!match) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const login = decoded.split(":")[0];
  return adminLogins.includes(login) ? login : null;
}
