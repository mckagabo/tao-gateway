import { BLOCKED_ROOTS, WORKSPACE_ROOTS } from "./uri.js";
import { urisOf } from "./params.js";

// The rules. Given who is asking and what they ask for, decide: let it through, let it through with the top folder
// swapped for the expert's own, refuse it, or send them to the login page. No network or database here: the two
// questions that need the database (what is this expert's folder, is this resource theirs) come in as `lookups`.

const STATIC = /\/views\/|\.(?:js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|map)$/i;

// Reachable without a known session: signing in and out, and what the login page itself loads.
const PUBLIC = [/^\/backoffice\/?$/, /^\/backoffice\/tao\/Main\/(?:login|logout|entry)\/?$/, /^\/backoffice\/tao\/ClientConfig\/config\/?$/];

// The parts of the back office an expert may use: the shell, their background tasks, tests and items.
const EXPERT_ALLOWED = [
  /^\/backoffice\/tao\/Main\//,
  /^\/backoffice\/taoCe\/(?:Main|Home)\//,
  /^\/backoffice\/tao\/ClientConfig\//,
  /^\/backoffice\/tao\/TaskQueueWebApi\//,
  /^\/backoffice\/tao\/(?:RestResource|RestClass|Lock)\//,
  // Uploading files (item and media import) and serving them back (audio, images): their addresses are file keys.
  // TAO's pages report their own script errors here; refusing it shows experts a false "logged out" message.
  /^\/backoffice\/tao\/Log\//,
  /^\/backoffice\/tao\/File\//,
  /^\/backoffice\/tao\/getFileFlysystem\.php\//,
  /^\/backoffice\/taoTests\//,
  /^\/backoffice\/taoItems\//,
  /^\/backoffice\/taoQtiTest\//,
  /^\/backoffice\/taoQtiItem\//,
  /^\/backoffice\/taoQtiTestPreviewer\//,
  /^\/backoffice\/taoRevision\//,
  // Loaders for custom interactions (PCI/PIC) used while editing and previewing questions.
  /^\/backoffice\/qtiItem(?:Pci|Pic)\//,
];

// Never for experts, even inside an allowed area: editing the shared definition of what a test or item is.
const EXPERT_FORBIDDEN = /PropertiesAuthoring|editClassProperties|addClassProperty|removeClassProperty/i;

// Calls that list a folder. Without a folder named they would list the top one, so for experts one must be named.
const NEEDS_TARGET = /\/(?:getOntologyData|RestResource|RestClass)\b|\/taoQtiTest\/Items\//;

const EXPERT_EXTENSIONS = new Set(["tao", "taoCe", "taoTests", "taoItems", "taoQtiTest", "taoQtiItem"]);

const pass = (reason = "ok", replacements = []) => ({ action: "pass", reason, replacements });
// `detail` says which address (or path) caused the refusal, so the log can show it.
const deny = (reason, detail = null) => ({ action: "deny", reason, detail, replacements: [] });

export function isStatic(path) {
  return STATIC.test(path);
}

function queryValue(query, name) {
  try {
    return new URLSearchParams(query ?? "").get(name);
  } catch {
    return null;
  }
}

// request: { method, path, query, contentType, body }   identity: from classifyLogin (+ userUri for experts)
// lookups: { workspaceFor(expertId, tree) -> uri|null, isOwned(uri, expertId) -> boolean }   localNamespace: where
// this TAO's own resources live, e.g. "https://communityedition.tao/ontologies/tao.rdf#"
export async function decide({ request, identity, lookups, localNamespace }) {
  const path = request.path;
  if (isStatic(path)) return pass("static");
  if (identity.kind === "admin") return pass("admin");
  if (PUBLIC.some((rule) => rule.test(path))) return pass("public");

  if (identity.kind === "anonymous") return { action: "login", reason: "unknown_session", replacements: [] };
  // Learners take exams on addresses that never reach the gateway. Anything else in the back office is not theirs.
  if (identity.kind !== "expert") return deny(`not_for_${identity.kind}`);

  if (!EXPERT_ALLOWED.some((rule) => rule.test(path))) return deny("area_not_allowed", path);
  if (EXPERT_FORBIDDEN.test(path)) return deny("shared_definitions");
  const extension = queryValue(request.query, "ext");
  if (extension && !EXPERT_EXTENSIONS.has(extension)) return deny("area_not_allowed");

  // Background-task status (import progress and the like): the task ids are not content an expert owns.
  if (/^\/backoffice\/tao\/TaskQueueWebApi\//.test(path)) return pass("task_status");

  const uris = urisOf(request);
  if (!uris) return deny("unreadable_body");

  const replacements = [];
  let namesTarget = false;
  for (const uri of uris) {
    const tree = Object.keys(WORKSPACE_ROOTS).find((key) => WORKSPACE_ROOTS[key] === uri);
    if (tree) {
      const workspace = await lookups.workspaceFor(identity.expertId, tree);
      if (!workspace) return deny(`no_workspace_${tree}`);
      replacements.push([uri, workspace]);
      namesTarget = true;
      continue;
    }
    if (BLOCKED_ROOTS.includes(uri)) return deny("area_not_allowed", uri);
    if (!uri.startsWith(localNamespace)) continue; // TAO's own vocabulary (field names, models): not a resource
    if (identity.userUri && uri === identity.userUri) continue; // the expert's own account
    if (!(await lookups.isOwned(uri, identity.expertId))) return deny("not_owner", uri);
    namesTarget = true;
  }

  if (NEEDS_TARGET.test(path) && !namesTarget) return deny("no_target");
  return pass(replacements.length ? "own_folder" : "ok", replacements);
}

// Whether a decision is applied or only logged. Enforcement is switched on for everyone ("*"), for a list of logins
// (a trial on one expert), or not at all.
export function isEnforced({ mode, enforceLogins }, identity) {
  if (mode !== "enforce") return false;
  if (enforceLogins.includes("*")) return true;
  return Boolean(identity.login) && enforceLogins.includes(identity.login);
}
