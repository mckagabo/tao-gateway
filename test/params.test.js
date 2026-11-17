import test from "node:test";
import assert from "node:assert/strict";
import { buildMultipart, parseMultipart, rewriteRequest, urisOf } from "../src/params.js";
import { TEST_ROOT } from "../src/uri.js";

const RES = "https://communityedition.tao/ontologies/tao.rdf#i1111111111111111111111111111";
const WS = "https://communityedition.tao/ontologies/tao.rdf#i2222222222222222222222222222";

function upload(fields, file) {
  const boundary = "----tb123";
  const parts = Object.entries(fields).map(([name, value]) => ({ headers: `Content-Disposition: form-data; name="${name}"`, body: Buffer.from(value), isFile: false }));
  parts.push({ headers: `Content-Disposition: form-data; name="content"; filename="q.zip"\r\nContent-Type: application/zip`, body: file, isFile: true });
  return { boundary, body: buildMultipart(parts, boundary) };
}

test("addresses are read from the query, a form body and JSON", () => {
  assert.ok(urisOf({ path: "/x", query: `uri=${encodeURIComponent(RES)}`, body: Buffer.alloc(0) }).has(RES));
  const form = { path: "/x", query: "", contentType: "application/x-www-form-urlencoded", body: Buffer.from(`classUri=${encodeURIComponent(TEST_ROOT)}`) };
  assert.ok(urisOf(form).has(TEST_ROOT));
  const json = { path: "/x", query: "", contentType: "application/json", body: Buffer.from(JSON.stringify({ uri: RES })) };
  assert.ok(urisOf(json).has(RES));
});

test("an upload's text fields are read, and its file is never altered", () => {
  const file = Buffer.from([0, 1, 2, 255, 254, 13, 10, 45, 45, 0, 7]);
  const { boundary, body } = upload({ classUri: TEST_ROOT, importHandler: "x" }, file);
  const request = { path: "/backoffice/taoItems/Items/import", query: "", contentType: `multipart/form-data; boundary=${boundary}`, body };
  assert.ok(urisOf(request).has(TEST_ROOT));

  const rewritten = rewriteRequest(request, [[TEST_ROOT, WS]]);
  const parts = parseMultipart(rewritten.body, boundary);
  assert.equal(parts.find((p) => !p.isFile && p.headers.includes('name="classUri"')).body.toString(), WS);
  assert.deepEqual(parts.find((p) => p.isFile).body, file);
  assert.equal(urisOf(rewritten).has(TEST_ROOT), false);
});

test("a broken upload can't be read, so it is reported as such", () => {
  const request = { path: "/x", query: "", contentType: "multipart/form-data; boundary=abc", body: Buffer.from("not a multipart body") };
  assert.equal(urisOf(request), null);
});
