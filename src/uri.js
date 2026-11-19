// How TAO writes resource addresses, and how to find them in a request.
//
// TAO names every test, item, folder and user with an address ("URI"). In forms it rewrites them so they can be
// used as field names: "://" becomes "_2_", "/" "_1_", "." "_0_", "#" "_3_" and ":" "_4_".

export const TEST_ROOT = "http://www.tao.lu/Ontologies/TAOTest.rdf#Test";
export const ITEM_ROOT = "http://www.tao.lu/Ontologies/TAOItem.rdf#Item";
export const MEDIA_ROOT = "http://www.tao.lu/Ontologies/TAOMedia.rdf#Media";

// The top folder of each tree an expert may work in. A request for one of these is answered with the expert's own
// folder in that tree instead.
export const WORKSPACE_ROOTS = { tests: TEST_ROOT, items: ITEM_ROOT, media: MEDIA_ROOT };

// Top folders of the trees experts get no access to at all (deliveries, assets' shared top folder, people). The Media
// root stays listed here for safety, but it is a workspace root above, which is checked first.
export const BLOCKED_ROOTS = [
  "http://www.tao.lu/Ontologies/TAODelivery.rdf#AssembledDelivery",
  "http://www.tao.lu/Ontologies/TAOResult.rdf#DeliveryResult",
  "http://www.tao.lu/Ontologies/TAOMedia.rdf#Media",
  "http://www.tao.lu/Ontologies/TAOSubject.rdf#Subject",
  "http://www.tao.lu/Ontologies/TAOGroup.rdf#Group",
  "http://www.tao.lu/Ontologies/TAO.rdf#User",
  "http://www.tao.lu/Ontologies/generis.rdf#User",
  "http://www.tao.lu/Ontologies/generis.rdf#ClassRole",
];

// The top of the Results tree. TAO groups results by delivery, so its listing is filtered to the expert's own deliveries
// (see policy.js); asking for either of these anywhere else stays refused.
export const RESULT_TREE_ROOTS = [
  "http://www.tao.lu/Ontologies/TAODelivery.rdf#AssembledDelivery",
  "http://www.tao.lu/Ontologies/TAOResult.rdf#DeliveryResult",
];

export function encodeTaoUri(uri) {
  return uri.replace(/#/g, "_3_").replace(/:\/\//g, "_2_").replace(/\//g, "_1_").replace(/\./g, "_0_").replace(/:/g, "_4_");
}

export function decodeTaoUri(value) {
  if (!/^https?_2_/.test(value)) return value;
  return value.replace(/_0_/g, ".").replace(/_1_/g, "/").replace(/_2_/g, "://").replace(/_3_/g, "#").replace(/_4_/g, ":");
}

// Undoes URL-encoding that was applied more than once (an address inside a "redirect" parameter, for example).
// Each %XX is decoded on its own, so a deliberately broken escape elsewhere in the text can't stop the decoding and
// hide an address from the check.
export function fullyUrlDecode(value) {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    const next = current.replace(/%([0-9A-Fa-f]{2})/g, (match, hex) => {
      const code = parseInt(hex, 16);
      return code < 128 ? String.fromCharCode(code) : match;
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

// An address ends at whitespace, quotes, brackets, or the "&" and ";" that separate parameters.
const RAW_URI = /https?:\/\/[^\s"'<>\\,\[\]{}|^`&;]+/g;
const ENCODED_URI = /https?_2_[A-Za-z0-9_\-]+/g;

// Every TAO address mentioned anywhere in a piece of text, in plain form. Text can be a parameter name, a value, or
// a JSON document; addresses in TAO's form spelling are turned back into plain ones.
export function findUris(text) {
  const found = new Set();
  if (typeof text !== "string" || !text) return found;
  // "\/" is how some JSON writers spell "/".
  const decoded = fullyUrlDecode(text).replace(/\\\//g, "/");
  for (const match of decoded.match(RAW_URI) ?? []) found.add(match.replace(/[.)]+$/, ""));
  for (const match of decoded.match(ENCODED_URI) ?? []) found.add(decodeTaoUri(match));
  return found;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Replaces one address with another wherever it appears in a raw query string or body, in each spelling it can
// take (plain, URL-encoded once or twice, TAO's form spelling). The address must end there: "…#Item" is replaced,
// "…#ItemModel" is not.
export function replaceUri(text, from, to) {
  if (typeof text !== "string" || !text) return text;
  const once = encodeURIComponent;
  const pairs = [
    [from, to],
    [once(from), once(to)],
    [once(once(from)), once(once(to))],
    [encodeTaoUri(from), encodeTaoUri(to)],
  ];
  let result = text;
  for (const [a, b] of pairs) {
    result = result.replace(new RegExp(`${escapeRegExp(a)}(?![A-Za-z0-9])`, "g"), () => b);
  }
  return result;
}
