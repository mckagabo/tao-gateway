import test from "node:test";
import assert from "node:assert/strict";
import { ITEM_ROOT, TEST_ROOT, decodeTaoUri, encodeTaoUri, findUris, replaceUri } from "../src/uri.js";

const RES = "https://communityedition.tao/ontologies/tao.rdf#i6af73c94829d320261113163636c1f08c32";

test("TAO's form spelling round-trips", () => {
  const encoded = encodeTaoUri("http://www.tao.lu/Ontologies/TAOItem.rdf#ItemAuthor");
  assert.equal(encoded, "http_2_www_0_tao_0_lu_1_Ontologies_1_TAOItem_0_rdf_3_ItemAuthor");
  assert.equal(decodeTaoUri(encoded), "http://www.tao.lu/Ontologies/TAOItem.rdf#ItemAuthor");
  assert.equal(decodeTaoUri(encodeTaoUri(RES)), RES);
});

test("addresses are found in every spelling", () => {
  const query = `classUri=${encodeURIComponent(TEST_ROOT)}&selected=${encodeURIComponent(RES)}`;
  assert.deepEqual([...findUris(query)].sort(), [RES, TEST_ROOT].sort());
  assert.ok(findUris(`uri=${encodeTaoUri(RES)}&x=1`).has(RES));
  assert.ok(findUris(JSON.stringify({ items: [RES] })).has(RES));
  // inside a redirect parameter, encoded twice
  const nested = `redirect=${encodeURIComponent(`/backoffice/tao/Main/index?uri=${encodeURIComponent(RES)}`)}`;
  assert.ok(findUris(nested).has(RES));
});

test("the top folder is swapped only where it really is the top folder", () => {
  const ws = "https://communityedition.tao/ontologies/tao.rdf#iWORKSPACE";
  const query = `classUri=${encodeURIComponent(ITEM_ROOT)}&model=${encodeURIComponent(ITEM_ROOT + "Model")}`;
  const out = replaceUri(query, ITEM_ROOT, ws);
  assert.ok(out.includes(encodeURIComponent(ws)));
  assert.ok(out.includes(encodeURIComponent(ITEM_ROOT + "Model")), "…#ItemModel must be left alone");
  assert.equal(findUris(out).has(ITEM_ROOT), false);
  // TAO's form spelling too
  const form = `id=${encodeTaoUri(TEST_ROOT)}&p=${encodeTaoUri(TEST_ROOT + "TestModel")}`;
  const formOut = replaceUri(form, TEST_ROOT, ws);
  assert.ok(formOut.includes(encodeTaoUri(ws)));
  assert.ok(formOut.includes(encodeTaoUri(TEST_ROOT + "TestModel")));
});

test("a broken escape elsewhere can't hide an address", () => {
  assert.ok(findUris(`junk=%ZZ%&uri=${encodeURIComponent(RES)}`).has(RES));
  assert.ok(findUris(`junk=%E0%A4%A&uri=${encodeURIComponent(encodeURIComponent(RES))}`).has(RES));
});
