import http from "node:http";
import https from "node:https";
import { createLookups } from "./db.js";
import { rewriteRequest } from "./params.js";
import { decide, isEnforced } from "./policy.js";
import { SessionStore, classifyLogin, cookiePairs, setCookiePairs } from "./sessions.js";
import { WORKSPACE_ROOTS } from "./uri.js";

// The gateway itself: sits between nginx and TAO for the back office. For each request it works out who is asking,
// asks the rules (policy.js) what to do, and then forwards, forwards with the top folder swapped, refuses, or sends
// the browser to the login page. In "observe" mode it forwards everything untouched and only logs what it would do.

const env = process.env;
const list = (value, fallback) => (value ?? fallback).split(",").map((item) => item.trim()).filter(Boolean);

const config = {
  port: Number(env.LISTEN_PORT || 8080),
  upstreamHost: env.UPSTREAM_HOST || "tao",
  upstreamPort: Number(env.UPSTREAM_PORT || 443),
  upstreamTls: env.UPSTREAM_TLS !== "false",
  publicHost: env.PUBLIC_HOST || "assessment.topbrainer.com",
  mode: env.MODE === "enforce" ? "enforce" : "observe",
  enforceLogins: list(env.ENFORCE_LOGINS, ""),
  adminLogins: list(env.ADMIN_LOGINS, "taoAdmin"),
  localNamespace: env.LOCAL_NAMESPACE || "https://communityedition.tao/ontologies/tao.rdf#",
  sessionFile: env.SESSION_FILE || "/data/sessions.json",
  maxBody: Number(env.MAX_BODY_BYTES || 256 * 1024 * 1024),
  databaseUrl: env.DATABASE_URL,
};

const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));

const sessions = new SessionStore({ file: config.sessionFile });
const lookups = createLookups({ connectionString: config.databaseUrl, roots: WORKSPACE_ROOTS });

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forward(req, res, { path, query, body }, onResponse) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
  headers.host = req.headers.host || config.publicHost;
  if (body && body.length) headers["content-length"] = String(body.length);
  else delete headers["content-length"];

  const transport = config.upstreamTls ? https : http;
  const upstream = transport.request(
    {
      host: config.upstreamHost,
      port: config.upstreamPort,
      method: req.method,
      path: query ? `${path}?${query}` : path,
      headers,
      servername: config.publicHost,
      rejectUnauthorized: false, // TAO's own certificate is self-signed inside the Docker network
      timeout: 300_000,
    },
    (upstreamRes) => {
      onResponse?.(upstreamRes);
      const out = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (error) => {
    log({ event: "upstream_error", path, error: String(error.message) });
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("TAO is not reachable right now.");
  });
  if (body && body.length) upstream.write(body);
  upstream.end();
}

function refuse(req, res, reason) {
  const wantsJson = /json/i.test(req.headers.accept ?? "") || req.headers["x-requested-with"] === "XMLHttpRequest";
  const message = "This is outside your own workspace.";
  if (wantsJson) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, message, errorMsg: message, code: reason }));
    return;
  }
  res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Not available</title><body style="font-family:sans-serif;padding:3rem"><h1>Not available</h1><p>${message}</p><p><a href="/backoffice/tao/Main/index?structure=tests&ext=taoTests">Back to your tests</a></p>`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://gateway.local");
  const path = url.pathname;
  const query = url.search.slice(1);

  if (path === "/__gateway/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: config.mode }));
    return;
  }

  let body;
  try {
    body = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req, config.maxBody);
  } catch (error) {
    res.writeHead(error.status || 400, { "content-type": "text/plain" });
    res.end("Request could not be read.");
    return;
  }

  const request = { method: req.method, path, query, contentType: req.headers["content-type"] ?? "", body };

  // Signing in: note which login this browser session becomes, if TAO accepts it.
  if (req.method === "POST" && /^\/backoffice\/tao\/Main\/login\/?$/.test(path)) {
    let login = null;
    try {
      login = new URLSearchParams(body.toString("utf8")).get("login");
    } catch {
      /* not a form: nothing to note */
    }
    forward(req, res, request, (upstreamRes) => {
      const accepted = upstreamRes.statusCode === 302 && !/Main\/login/.test(String(upstreamRes.headers.location ?? ""));
      if (login && accepted) {
        sessions.remember([...cookiePairs(req.headers.cookie), ...setCookiePairs(upstreamRes.headers["set-cookie"])], login);
        log({ event: "login", login: classifyLogin(login, config.adminLogins).kind === "admin" ? login : login.slice(0, 14) + "…", kind: classifyLogin(login, config.adminLogins).kind });
      }
    });
    return;
  }
  if (/^\/backoffice\/tao\/Main\/logout\/?$/.test(path)) {
    sessions.forget(cookiePairs(req.headers.cookie));
    forward(req, res, request);
    return;
  }

  const identity = classifyLogin(sessions.find(req.headers.cookie), config.adminLogins);
  let decision;
  try {
    if (identity.kind === "expert") identity.userUri = await lookups.userUriFor(identity.login);
    decision = await decide({ request, identity, lookups, localNamespace: config.localNamespace });
  } catch (error) {
    // The rules could not be evaluated (database down, for instance). Enforced sessions are refused, never waved through.
    log({ event: "decision_error", path, error: String(error?.message ?? error) });
    decision = { action: "deny", reason: "gateway_error", replacements: [] };
  }

  const enforced = isEnforced(config, identity);
  const notable = decision.action !== "pass" || decision.replacements.length > 0;
  if (notable) {
    log({
      event: enforced ? decision.action : `would_${decision.action}`,
      reason: decision.reason,
      kind: identity.kind,
      who: identity.expertId ?? identity.kind,
      method: req.method,
      path,
    });
  }

  if (!enforced) return forward(req, res, request);
  if (decision.action === "deny") return refuse(req, res, decision.reason);
  if (decision.action === "login") {
    res.writeHead(302, { location: "/backoffice/tao/Main/login" });
    res.end();
    return;
  }
  forward(req, res, decision.replacements.length ? rewriteRequest(request, decision.replacements) : request);
});

server.listen(config.port, () => log({ event: "started", port: config.port, mode: config.mode, enforceLogins: config.enforceLogins }));

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => lookups.close().finally(() => process.exit(0)));
  });
}
