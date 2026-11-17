// Filtering TAO's tree answers. Instead of changing which folder the expert asks for (which changes the SHAPE of the
// answer and breaks TAO's page script), TAO answers normally and everything that is not the expert's is removed:
// every node is kept only if the expert owns it, or it is one of the folders on the way down to their own.
//
// A tree answer is { tree: <root node with children> } for the top of the tree, and { tree: [ <nodes> ] } when a
// folder is expanded. Both shapes are handled.

const uriOf = (node) => (node && node.attributes && typeof node.attributes["data-uri"] === "string" ? node.attributes["data-uri"] : null);

// keep(uri) -> Promise<boolean>. `isRootNode` marks the top folder, which is always kept so the tree keeps its shape.
export async function pruneNodes(nodes, keep) {
  const kept = [];
  for (const node of nodes) {
    const uri = uriOf(node);
    if (!uri || !(await keep(uri))) continue;
    if (Array.isArray(node.children)) node.children = await pruneNodes(node.children, keep);
    kept.push(node);
  }
  return kept;
}

export async function pruneTreeAnswer(json, { keep, rootUri }) {
  if (!json || typeof json !== "object") return json;
  const tree = json.tree;
  if (Array.isArray(tree)) {
    json.tree = await pruneNodes(tree, keep);
  } else if (tree && typeof tree === "object") {
    // The top folder itself is always kept; only what is under it is filtered.
    if (Array.isArray(tree.children)) {
      tree.children = await pruneNodes(tree.children, async (uri) => (uri === rootUri ? true : keep(uri)));
    }
  }
  return json;
}
