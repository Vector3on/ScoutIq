import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import {
  loadRules,
  scanText,
  rankSeeds,
  scoreSeed,
  dedupeSeeds,
  summarize,
  coverage,
  shannonEntropy,
  redactSnippet,
  extToLang,
} from "../scripts/audit-core.mjs";
import {
  checkTarget,
  hostMatchesRule,
  isPrivateOrMetadata,
  parseHost,
} from "../scripts/scope-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const rules = await loadRules(root);

function scan(text, lang = "js", path = "fixture") {
  return scanText({ path, text, lang, detectors: rules.detectors, methodologyById: rules.methodologyById });
}

function ids(seeds) {
  return seeds.map((s) => s.detectorId).sort();
}

// ---- true positives -----------------------------------------------------

test("flags string-concatenated SQL with request input", () => {
  const seeds = scan('const q = "SELECT * FROM users WHERE id = " + req.query.id;');
  assert.ok(ids(seeds).includes("sqli-concat"));
  assert.equal(seeds.find((s) => s.detectorId === "sqli-concat").item, 44);
});

test("flags interpolated template-literal SQL", () => {
  const seeds = scan("db.query(`SELECT * FROM accounts WHERE id = ${userId}`);");
  assert.ok(ids(seeds).includes("sqli-template-literal"));
});

test("flags a non-placeholder AWS access key id", () => {
  const seeds = scan('const k = "AKIAZ7XQ2PLMN4RTVWXY";');
  assert.ok(ids(seeds).includes("secret-aws-akid"));
  assert.equal(seeds.find((s) => s.detectorId === "secret-aws-akid").confidence, "high");
});

test("flags TLS verification disabled", () => {
  assert.ok(ids(scan("const agent = new https.Agent({ rejectUnauthorized: false });")).includes("tls-verify-disabled"));
  assert.ok(ids(scan("tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}", "go")).includes("tls-verify-disabled"));
});

test("flags an unscoped ORM fetch by request id (IDOR seed)", () => {
  assert.ok(ids(scan("const doc = await Note.findByPk(req.params.id);")).includes("idor-orm-fetch-by-req"));
});

test("flags a Rails unscoped Model.find(params[:id])", () => {
  assert.ok(ids(scan("note = Note.find(params[:id])", "rb")).includes("idor-rails-find"));
});

test("flags mass assignment from req.body", () => {
  assert.ok(ids(scan("await User.update({ ...req.body });")).includes("mass-assign-spread-body"));
});

test("flags Python pickle and unsafe yaml.load", () => {
  assert.ok(ids(scan("obj = pickle.loads(request.data)", "py")).includes("deser-pickle"));
  assert.ok(ids(scan("cfg = yaml.load(request.data)", "py")).includes("deser-yaml-load"));
});

test("flags path traversal from request into a file read", () => {
  assert.ok(ids(scan("fs.readFileSync(path.join(base, req.params.file));")).includes("path-join-user"));
});

test("flags JWT alg none and verify:false", () => {
  assert.ok(ids(scan("jwt.verify(t, key, { algorithms: ['none'] });")).includes("jwt-alg-none"));
  assert.ok(ids(scan("const p = decode(token, { verify: false });")).includes("jwt-verify-false"));
});

test("flags open redirect from request", () => {
  assert.ok(ids(scan("res.redirect(req.query.next);")).includes("open-redirect"));
});

// ---- function detectors -------------------------------------------------

test("postMessage listener without an origin check is flagged; with one it is not", () => {
  const bad = scan("window.addEventListener('message', function (e) {\n  applyConfig(e.data);\n});");
  assert.ok(ids(bad).includes("postmessage-listener"));
  const good = scan("window.addEventListener('message', function (e) {\n  if (e.origin !== 'https://trusted.example') return;\n  applyConfig(e.data);\n});");
  assert.ok(!ids(good).includes("postmessage-listener"));
});

test("weak RNG is flagged near a token context, ignored otherwise", () => {
  const bad = scan("const resetToken = 'r' + Math.random().toString(36).slice(2);");
  assert.ok(ids(bad).includes("weak-random-secret"));
  const good = scan("const jitterMs = Math.random() * 100;");
  assert.ok(!ids(good).includes("weak-random-secret"));
});

test("non-constant-time secret compare is flagged; timingSafeEqual is not", () => {
  const bad = scan("if (userSig === expectedSignature) { grant(); }");
  assert.ok(ids(bad).includes("timing-unsafe-compare"));
  const good = scan("if (crypto.timingSafeEqual(sigBuf, expectedBuf)) { grant(); }");
  assert.ok(!ids(good).includes("timing-unsafe-compare"));
});

test("missing return after a 401 is flagged; a returned 403 is not", () => {
  const bad = scan("if (!user) res.status(401).json({ error: 'no' })\ngrantAccess()");
  assert.ok(ids(bad).includes("missing-return-after-auth"));
  const good = scan("if (!user) return res.status(403).json({ error: 'no' })\ngrantAccess()");
  assert.ok(!ids(good).includes("missing-return-after-auth"));
});

// ---- false-positive discipline -----------------------------------------

test("parameterized SQL produces no injection seed", () => {
  const seeds = scan("db.query('SELECT * FROM users WHERE id = ?', [req.params.id]);");
  assert.ok(!ids(seeds).includes("sqli-concat"));
  assert.ok(!ids(seeds).includes("sqli-template-literal"));
});

test("placeholder secrets are dropped by the entropy/placeholder gate", () => {
  assert.equal(scan('const password = "your_password_here";').length, 0);
  assert.equal(scan('const api_key = "changeme12345";').length, 0);
  assert.equal(scan('const client_secret = "xxxxxxxxxxxx";').length, 0);
});

test("a high-entropy generic secret survives the gate as low/medium", () => {
  const seeds = scan("const client_secret = 'a8Fk2Lm9Qz7Xw3Vb6Nc1Pd4';");
  const hit = seeds.find((s) => s.detectorId === "secret-generic-assign");
  assert.ok(hit);
  assert.ok(["low", "medium"].includes(hit.confidence));
});

test("AWS docs placeholder key is allowlisted", () => {
  assert.equal(scan('const k = "AKIAIOSFODNN7EXAMPLE";').length, 0);
});

test("minified / very-long lines are skipped", () => {
  const huge = `var x="${"a".repeat(5000)}"+req.query.q;`;
  assert.equal(scan(huge).length, 0);
});

// ---- precision fixes surfaced by the Magento (Adobe Commerce) SRC run -----

test("RegExp .exec() is not mistaken for a shell exec", () => {
  assert.ok(!ids(scan("const match = Optional.from(pattern.exec(input));")).includes("cmdi-node-exec"));
  assert.ok(ids(scan("child_process.exec('ls ' + req.query.dir);")).includes("cmdi-node-exec"));
  assert.ok(ids(scan("const { exec } = require('child_process'); exec(req.body.cmd);")).includes("cmdi-node-exec"));
});

test("the word 'update' in an identifier is not mistaken for SQL", () => {
  assert.ok(!ids(scan("button.broadcastOn([`update-active-item-${treeId}`], { value: leaf.id });")).includes("sqli-template-literal"));
  assert.ok(!ids(scan("const isMimeType = (mime, type) => startsWith(mime, `${type}/`);")).includes("sqli-template-literal"));
  assert.ok(ids(scan("db.query(`UPDATE users SET name = ${n} WHERE id = ${id}`);")).includes("sqli-template-literal"));
});

test("config/module path values are not flagged as hardcoded secrets", () => {
  assert.equal(scan("const CONFIG_PATH_PASSWORD = 'cache/frontend/default/backend_password';").length, 0);
  assert.equal(scan("const XML_PATH_YOUTUBE_API_KEY = 'catalog/product_video/youtube_api_key';").length, 0);
  assert.equal(scan("changeEmailPassword: 'Magento_Customer/js/change-email-password',").length, 0);
});

test("weak RNG for non-crypto data generation is not flagged", () => {
  assert.ok(!ids(scan("$set = array_keys($defaultAttributeSets)[mt_rand(0, $amount - 1)];", "php")).includes("weak-random-secret"));
  assert.ok(!ids(scan("// mt_rand() here is not for cryptographic use.\n$token = mt_rand(1, 5);", "php")).includes("weak-random-secret"));
  assert.ok(ids(scan("const sessionToken = 'r' + Math.random().toString(36);")).includes("weak-random-secret"));
});

// ---- scoring, dedup, ranking, summary -----------------------------------

test("seeds rank by priority x confidence, high/P1 first", () => {
  const seeds = [
    { detectorId: "a", path: "f", line: 1, priority: "P3", confidence: "low", section: "X", item: 1 },
    { detectorId: "b", path: "f", line: 2, priority: "P1", confidence: "high", section: "Y", item: 2 },
  ];
  const ranked = rankSeeds(seeds);
  assert.equal(ranked[0].detectorId, "b");
  assert.ok(scoreSeed(seeds[1]) > scoreSeed(seeds[0]));
});

test("duplicate seeds at the same site are collapsed", () => {
  const s = { detectorId: "a", path: "f", line: 1, priority: "P1", confidence: "high" };
  assert.equal(dedupeSeeds([s, { ...s }]).length, 1);
});

test("summary counts by confidence and priority", () => {
  const summary = summarize([
    { section: "A", item: 1, confidence: "high", priority: "P1" },
    { section: "A", item: 2, confidence: "low", priority: "P3" },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.byConfidence.high, 1);
  assert.equal(summary.byPriority.P3, 1);
  assert.equal(summary.distinctItems, 2);
});

test("methodology has 100 items and coverage splits automated vs manual", () => {
  const cov = coverage(rules);
  assert.equal(cov.totalItems, 100);
  assert.ok(cov.automatedItems >= 20);
  assert.equal(cov.automatedItems + cov.manualItems, cov.totalItems);
});

// ---- helpers ------------------------------------------------------------

test("entropy separates random strings from repetitive ones", () => {
  assert.ok(shannonEntropy("a8Fk2Lm9Qz7Xw3Vb6Nc1Pd4") > 4);
  assert.ok(shannonEntropy("aaaaaaaaaaaa") < 1);
});

test("redactSnippet masks obvious secret material", () => {
  assert.match(redactSnippet('key = "AKIAZ7XQ2PLMN4RTVWXY"'), /AKIAZ7XQ…REDACTED/);
  assert.doesNotMatch(redactSnippet("-----BEGIN RSA PRIVATE KEY-----"), /BEGIN RSA PRIVATE KEY---$/);
});

test("extToLang normalizes extensions", () => {
  assert.equal(extToLang(".tsx"), "ts");
  assert.equal(extToLang("mjs"), "js");
  assert.equal(extToLang(".py"), "py");
});

// ---- scope guard (fail-closed) ------------------------------------------

const verified = { verifiedByUser: true, inScope: ["*.example.com", "api.example.org"], outOfScope: ["admin.example.com"] };

test("scope guard is fail-closed on unverified engagements", () => {
  assert.equal(checkTarget("https://app.example.com", { verifiedByUser: false, inScope: ["*.example.com"] }).decision, "deny");
  assert.equal(checkTarget("https://app.example.com", null).decision, "deny");
});

test("scope guard allows verified in-scope and denies unknown/out-of-scope", () => {
  assert.equal(checkTarget("https://app.example.com/x", verified).decision, "allow");
  assert.equal(checkTarget("https://api.example.org", verified).decision, "allow");
  assert.equal(checkTarget("https://evil.test", verified).decision, "deny");
  const out = checkTarget("https://admin.example.com", verified);
  assert.equal(out.decision, "deny");
  assert.equal(out.matchedRule, "admin.example.com");
});

test("scope guard ALWAYS blocks private/loopback/metadata even when in-scope + verified", () => {
  const eng = { verifiedByUser: true, inScope: ["*"], outOfScope: [] };
  assert.equal(checkTarget("http://169.254.169.254/latest/meta-data/", eng).decision, "deny");
  assert.equal(checkTarget("http://127.0.0.1:8080", eng).decision, "deny");
  assert.equal(checkTarget("http://10.0.0.5", eng).decision, "deny");
  assert.equal(checkTarget("http://metadata.google.internal", eng).decision, "deny");
  assert.equal(checkTarget("http://localhost", eng).decision, "deny");
});

test("private ranges can be opted in explicitly for an authorized internal target", () => {
  const eng = { verifiedByUser: true, inScope: ["10.0.0.5"], outOfScope: [], allowPrivateRanges: true };
  assert.equal(checkTarget("http://10.0.0.5", eng).decision, "allow");
});

test("host matching handles exact, wildcard, and suffix rules", () => {
  assert.ok(hostMatchesRule("app.example.com", "*.example.com"));
  assert.ok(hostMatchesRule("example.com", ".example.com"));
  assert.ok(hostMatchesRule("example.com", "example.com"));
  assert.ok(!hostMatchesRule("notexample.com", "*.example.com"));
  assert.ok(!hostMatchesRule("evil.com", "example.com"));
});

test("isPrivateOrMetadata classifies the usual internal targets", () => {
  for (const h of ["169.254.169.254", "127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "::1", "localhost"]) {
    assert.equal(isPrivateOrMetadata(h), true, h);
  }
  for (const h of ["93.184.216.34", "example.com", "8.8.8.8"]) {
    assert.equal(isPrivateOrMetadata(h), false, h);
  }
});

test("parseHost extracts hosts from urls and bare hosts", () => {
  assert.equal(parseHost("https://app.example.com/a/b?c=1"), "app.example.com");
  assert.equal(parseHost("app.example.com"), "app.example.com");
  assert.equal(parseHost("has spaces so invalid"), null);
});
