import test from "node:test";
import assert from "node:assert/strict";
import { pruneTreeAnswer } from "../src/prune.js";

const ns = "https://communityedition.tao/ontologies/tao.rdf#";
const node = (uri, data, extra = {}) => ({ data, type: extra.type ?? "class", attributes: { id: "x", "data-uri": uri }, ...extra });
const ROOT = "http://www.tao.lu/Ontologies/TAOTest.rdf#Test";
const SHARED = `${ns}iSHARED`;
const MINE_FOLDER = `${ns}iMINEFOLDER`;
const MY_TEST = `${ns}iMYTEST`;
const OTHER_FOLDER = `${ns}iOTHERFOLDER`;
const OTHER_TEST = `${ns}iOTHERTEST`;
const LEGACY = `${ns}iLEGACYCLASS`;

const owned = new Set([MY_TEST, MINE_FOLDER]);
const above = new Set([ROOT, SHARED, MINE_FOLDER]);
const keep = async (uri) => above.has(uri) || owned.has(uri);

test("the top of the tree keeps its shape and shows only the way to the expert's folder", async () => {
  const answer = {
    tree: {
      ...node(ROOT, "Test"),
      state: "open",
      children: [
        node(LEGACY, "Test_1"),
        node(OTHER_TEST, "Accounting exam", { type: "instance" }),
        {
          ...node(SHARED, "TopBrainer Instructors"),
          state: "open",
          children: [
            { ...node(MINE_FOLDER, "Cedric"), children: [node(MY_TEST, "Jonella", { type: "instance" })] },
            node(OTHER_FOLDER, "Someone else"),
          ],
        },
      ],
    },
    permissions: { supportedRights: [] },
  };
  const out = await pruneTreeAnswer(answer, { keep, rootUri: ROOT });
  // still an object with a top node, as TAO's page expects
  assert.equal(Array.isArray(out.tree), false);
  assert.equal(out.tree.data, "Test");
  assert.deepEqual(out.tree.children.map((n) => n.data), ["TopBrainer Instructors"]);
  assert.deepEqual(out.tree.children[0].children.map((n) => n.data), ["Cedric"]);
  assert.deepEqual(out.tree.children[0].children[0].children.map((n) => n.data), ["Jonella"]);
  assert.deepEqual(out.permissions, { supportedRights: [] });
});

test("an expanded folder is a list, and only the expert's nodes stay in it", async () => {
  const answer = { tree: [node(MY_TEST, "Jonella", { type: "instance" }), node(OTHER_TEST, "Not mine", { type: "instance" }), node(OTHER_FOLDER, "Other")] };
  const out = await pruneTreeAnswer(answer, { keep, rootUri: ROOT });
  assert.deepEqual(out.tree.map((n) => n.data), ["Jonella"]);
});

test("a node with no address is dropped rather than passed through", async () => {
  const out = await pruneTreeAnswer({ tree: [{ data: "mystery", type: "class", attributes: {} }] }, { keep, rootUri: ROOT });
  assert.deepEqual(out.tree, []);
});

test("anything that is not a tree answer is left alone", async () => {
  assert.deepEqual(await pruneTreeAnswer({ success: true }, { keep, rootUri: ROOT }), { success: true });
  assert.equal(await pruneTreeAnswer(null, { keep, rootUri: ROOT }), null);
});
