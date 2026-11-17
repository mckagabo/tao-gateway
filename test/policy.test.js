import test from "node:test";
import assert from "node:assert/strict";
import { decide, isEnforced } from "../src/policy.js";
import { ITEM_ROOT, TEST_ROOT, encodeTaoUri } from "../src/uri.js";

const NS = "https://communityedition.tao/ontologies/tao.rdf#";
const ME = "e0e82a24-6820-4d34-9d98-e5c8d9108b4c";
const MY_TESTS = `${NS}iMYTESTS00000000000000000000`;
const MY_ITEMS = `${NS}iMYITEMS00000000000000000000`;
const MINE = `${NS}iMINE000000000000000000000000`;
const THEIRS = `${NS}iTHEIRS0000000000000000000000`;
const MY_USER = `${NS}iUSERME000000000000000000000`;

const lookups = {
  workspaceFor: async (id, tree) => (id === ME ? { tests: MY_TESTS, items: MY_ITEMS }[tree] : null),
  isOwned: async (uri, id) => id === ME && [MINE, MY_TESTS, MY_ITEMS].includes(uri),
};
const expert = { kind: "expert", login: "tb_x_tao_author", expertId: ME, userUri: MY_USER };
const q = (params) => new URLSearchParams(params).toString();
const ask = (identity, path, query = "", extra = {}) =>
  decide({ request: { method: "GET", path, query, contentType: "", body: Buffer.alloc(0), ...extra }, identity, lookups, localNamespace: NS });

test("admin and static files always pass", async () => {
  assert.equal((await ask({ kind: "admin", login: "taoAdmin" }, "/backoffice/tao/Users/index")).action, "pass");
  assert.equal((await ask({ kind: "anonymous" }, "/backoffice/tao/views/css/tao-3.css")).action, "pass");
});

test("an unknown session can reach the login page and nothing else", async () => {
  assert.equal((await ask({ kind: "anonymous" }, "/backoffice/tao/Main/login")).action, "pass");
  assert.equal((await ask({ kind: "anonymous" }, "/backoffice/taoTests/Tests/getOntologyData", q({ classUri: TEST_ROOT }))).action, "login");
});

test("the expert's tree is rooted at their own folder", async () => {
  const tests = await ask(expert, "/backoffice/taoTests/Tests/getOntologyData", q({ classUri: TEST_ROOT, selected: MINE }));
  assert.equal(tests.action, "pass");
  assert.deepEqual(tests.replacements, [[TEST_ROOT, MY_TESTS]]);
  const items = await ask(expert, "/backoffice/taoItems/Items/getOntologyData", q({ classUri: ITEM_ROOT }));
  assert.deepEqual(items.replacements, [[ITEM_ROOT, MY_ITEMS]]);
});

test("another expert's resource is refused, however it is spelled", async () => {
  assert.equal((await ask(expert, "/backoffice/taoTests/Tests/editTest", q({ uri: THEIRS }))).reason, "not_owner");
  assert.equal((await ask(expert, "/backoffice/taoItems/Items/editItem", `uri=${encodeTaoUri(THEIRS)}`)).reason, "not_owner");
  const posted = await ask(expert, "/backoffice/taoTests/Tests/delete", "", {
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: Buffer.from(q({ uri: THEIRS })),
  });
  assert.equal(posted.reason, "not_owner");
  const viaRedirect = await ask(expert, "/backoffice/tao/Main/index", q({ structure: "tests", ext: "taoTests", uri: THEIRS }));
  assert.equal(viaRedirect.reason, "not_owner");
  // moving their own test INTO someone else's folder is refused too
  assert.equal((await ask(expert, "/backoffice/taoTests/Tests/moveInstance", q({ uri: MINE, destinationClassUri: THEIRS }))).reason, "not_owner");
});

test("their own resources and account pass", async () => {
  assert.equal((await ask(expert, "/backoffice/taoTests/Tests/editTest", q({ uri: MINE }))).action, "pass");
  assert.equal((await ask(expert, "/backoffice/taoQtiItem/QtiCreator/getFile", q({ uri: MINE, relPath: "a.png" }))).action, "pass");
  assert.equal((await ask(expert, "/backoffice/tao/Main/index", q({ uri: MY_USER }))).action, "pass");
  assert.equal((await ask(expert, "/backoffice/tao/TaskQueueWebApi/getAll", "limit=100")).action, "pass");
});

test("a listing with no folder named would list everything, so it is refused", async () => {
  assert.equal((await ask(expert, "/backoffice/taoTests/Tests/getOntologyData", "limit=30")).reason, "no_target");
  assert.equal((await ask(expert, "/backoffice/tao/RestResource/getAll", "format=tree")).reason, "no_target");
});

test("results, deliveries, assets, people and search are closed to experts", async () => {
  for (const path of [
    "/backoffice/taoOutcomeUi/Results/index",
    "/backoffice/taoDeliveryRdf/DeliveryMgmt/editDelivery",
    "/backoffice/taoMediaManager/MediaManager/getOntologyData",
    "/backoffice/tao/Users/index",
    "/backoffice/taoTestTaker/TestTaker/index",
    "/backoffice/tao/Search/search",
    "/backoffice/taoEventLog/TaoEventLog/index",
  ]) {
    assert.equal((await ask(expert, path)).reason, "area_not_allowed", path);
  }
  assert.equal((await ask(expert, "/backoffice/tao/Main/index", q({ structure: "results", ext: "taoOutcomeUi" }))).reason, "area_not_allowed");
  assert.equal((await ask(expert, "/backoffice/taoTests/Tests/editClassProperties", q({ id: MY_TESTS }))).reason, "shared_definitions");
});

test("an expert with no folder yet sees nothing rather than everything", async () => {
  const stranger = { kind: "expert", login: "tb_y_tao_author", expertId: "00000000-0000-4000-8000-000000000000" };
  assert.equal((await ask(stranger, "/backoffice/taoItems/Items/getOntologyData", q({ classUri: ITEM_ROOT }))).reason, "no_workspace_items");
});

test("learners and unknown account types get no back office", async () => {
  assert.equal((await ask({ kind: "learner", login: "l" }, "/backoffice/taoTests/Tests/getOntologyData", q({ classUri: TEST_ROOT }))).action, "deny");
  assert.equal((await ask({ kind: "other", login: "o" }, "/backoffice/tao/Main/index")).action, "deny");
});

test("an upload that can't be read is refused", async () => {
  const result = await ask(expert, "/backoffice/taoItems/Items/import", "", {
    method: "POST",
    contentType: "multipart/form-data; boundary=abc",
    body: Buffer.from("garbage"),
  });
  assert.equal(result.reason, "unreadable_body");
});

test("enforcement can be off, on for one login, or on for all", () => {
  const who = { login: "tb_x_tao_author" };
  assert.equal(isEnforced({ mode: "observe", enforceLogins: ["*"] }, who), false);
  assert.equal(isEnforced({ mode: "enforce", enforceLogins: [] }, who), false);
  assert.equal(isEnforced({ mode: "enforce", enforceLogins: ["tb_x_tao_author"] }, who), true);
  assert.equal(isEnforced({ mode: "enforce", enforceLogins: ["someone_else"] }, who), false);
  assert.equal(isEnforced({ mode: "enforce", enforceLogins: ["*"] }, { login: null }), true);
});

test("a refusal says which address caused it", async () => {
  const refused = await ask(expert, "/backoffice/taoTests/Tests/editTest", q({ uri: THEIRS }));
  assert.equal(refused.detail, THEIRS);
});

test("custom interaction loaders are allowed for experts", async () => {
  assert.equal((await ask(expert, "/backoffice/qtiItemPci/PciLoader/load", "")).action, "pass");
});
