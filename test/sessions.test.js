import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore, classifyLogin, cookiePairs, setCookiePairs } from "../src/sessions.js";

test("logins are recognised by how TopBrainer names them", () => {
  assert.deepEqual(classifyLogin("taoAdmin"), { kind: "admin", login: "taoAdmin" });
  const expert = classifyLogin("tb_e0e82a24_6820_4d34_9d98_e5c8d9108b4c_tao_author");
  assert.equal(expert.kind, "expert");
  assert.equal(expert.expertId, "e0e82a24-6820-4d34-9d98-e5c8d9108b4c");
  assert.equal(classifyLogin("tb_e0e82a24_6820_4d34_9d98_e5c8d9108b4c_tao_learner").kind, "learner");
  assert.equal(classifyLogin("tb_e0e82a24_6820_4d34_9d98_e5c8d9108b4c_tao_AbCdEf0123").kind, "learner");
  assert.equal(classifyLogin("someone").kind, "other");
  assert.equal(classifyLogin(null).kind, "anonymous");
  // a look-alike must not pass as an expert
  assert.equal(classifyLogin("tb_nothex_tao_author").kind, "other");
});

test("a session is remembered by its cookies and forgotten on logout or expiry", () => {
  let now = 1_000;
  const store = new SessionStore({ ttlMs: 500, now: () => now });
  store.remember([...cookiePairs("PHPSESSID=old; other=1"), ...setCookiePairs(["PHPSESSID=new; path=/; HttpOnly"])], "taoAdmin");
  assert.equal(store.find("x=y; PHPSESSID=new"), "taoAdmin");
  assert.equal(store.find("PHPSESSID=unknown"), null);
  store.forget(cookiePairs("PHPSESSID=new"));
  assert.equal(store.find("PHPSESSID=new"), null);
  store.remember(["PHPSESSID=z"], "taoAdmin");
  now += 1_000;
  assert.equal(store.find("PHPSESSID=z"), null);
});

test("cookies being deleted are not taken for a session", () => {
  assert.deepEqual(setCookiePairs(["a=deleted; expires=x", "b=; path=/", "c=ok"]), ["c=ok"]);
});
