import pg from "pg";

// The two questions the rules ask TAO's own database (read-only): which folder is this expert's in a given tree, and
// is this resource inside one of their folders. TAO stores everything as rows of (subject, predicate, object) in the
// `statements` table.

const LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
const TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const LOGIN = "http://www.tao.lu/Ontologies/generis.rdf#login";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class TtlCache {
  constructor() {
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.until < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value, ttlMs) {
    if (this.map.size > 20_000) this.map.clear();
    this.map.set(key, { value, until: Date.now() + ttlMs });
  }
}

export function createLookups({ connectionString, roots }) {
  const pool = new pg.Pool({ connectionString, max: 4, idleTimeoutMillis: 30_000, statement_timeout: 5_000 });
  const cache = new TtlCache();

  // Every folder marked as this expert's, in any tree: its label carries "[TB-AUTHOR:<their id>]".
  async function workspacesOf(expertId) {
    if (!UUID.test(expertId)) return [];
    const key = `ws:${expertId}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const result = await pool.query("select distinct subject from statements where predicate = $1 and object like $2", [
      LABEL,
      `%[TB-AUTHOR:${expertId}]%`,
    ]);
    const list = result.rows.map((row) => row.subject);
    cache.set(key, list, list.length ? 60_000 : 10_000);
    return list;
  }

  // The expert's folder inside one tree ("tests" or "items"): the marked folder that sits under that tree's top folder.
  async function workspaceFor(expertId, tree) {
    const root = roots[tree];
    if (!root) return null;
    const key = `wsf:${expertId}:${tree}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const candidates = await workspacesOf(expertId);
    let found = null;
    if (candidates.length) {
      const result = await pool.query(
        `with recursive up(ws, c, depth) as (
           select w, w, 0 from unnest($1::text[]) as w
           union
           select up.ws, s.object, up.depth + 1 from statements s join up on s.subject = up.c
           where s.predicate = $2 and up.depth < 15
         )
         select ws from up where c = $3 limit 1`,
        [candidates, SUBCLASS, root]
      );
      found = result.rows[0]?.ws ?? null;
    }
    cache.set(key, found, found ? 60_000 : 10_000);
    return found;
  }

  // Is this resource the expert's: one of their folders, anything inside them, or something whose label carries their
  // id ("[TB:<id>:…]", how TopBrainer names the tests and deliveries it creates for them).
  async function isOwned(uri, expertId) {
    if (!UUID.test(expertId)) return false;
    const key = `own:${expertId}:${uri}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const workspaces = await workspacesOf(expertId);
    let owned = false;
    if (workspaces.length) {
      const inside = await pool.query(
        `with recursive up(c, depth) as (
           select $1::text, 0
           union
           select s.object, up.depth + 1 from statements s join up on s.subject = up.c
           where s.predicate in ($2, $3) and up.depth < 20
         )
         select 1 from up where c = any($4::text[]) limit 1`,
        [uri, TYPE, SUBCLASS, workspaces]
      );
      owned = inside.rowCount > 0;
    }
    if (!owned) {
      const tagged = await pool.query(
        "select 1 from statements where subject = $1 and predicate = $2 and (object like $3 or object like $4) limit 1",
        [uri, LABEL, `%[TB:${expertId}:%`, `%[TB:${expertId}]%`]
      );
      owned = tagged.rowCount > 0;
    }
    // A "no" is kept only briefly: a resource the expert just created becomes theirs a moment later.
    cache.set(key, owned, owned ? 30_000 : 3_000);
    return owned;
  }

  async function userUriFor(login) {
    const key = `user:${login}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = await pool.query("select subject from statements where predicate = $1 and object = $2 limit 1", [LOGIN, login]);
    const uri = result.rows[0]?.subject ?? null;
    cache.set(key, uri, uri ? 600_000 : 10_000);
    return uri;
  }

  return { workspaceFor, isOwned, userUriFor, close: () => pool.end() };
}
