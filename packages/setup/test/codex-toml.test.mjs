import assert from "node:assert/strict";
import test from "node:test";
import { clash, codexProfile } from "../dist/codex.js";

const profile = codexProfile({ port: 47821, token: "t0k", mode: "agent" });

test("the profile: top-level keys before any table, a command auth, the local token header and no key", () => {
  const firstTable = profile.indexOf("\n[");
  assert.ok(profile.indexOf('model_provider = "caveman"') < firstTable && profile.indexOf('model = "auto"') < firstTable);
  assert.match(profile, /auth = \{ command = "caveman-routerd", args = \["codex-auth"\] \}/);
  assert.match(profile, /wire_api = "responses"/);
  assert.match(profile, /"x-caveman-local-token" = "t0k"/);
  assert.doesNotMatch(profile, /env_key|requires_openai_auth|experimental_bearer_token|\[profiles\./);
  assert.match(profile, /\[\[hooks\.Stop\]\]\n\[\[hooks\.Stop\.hooks\]\]\ntype = "command"\ncommand = "caveman-router hook codex"\nasync = true\n/);
});

test("clash: a caveman provider, a legacy caveman profile, or selecting it", () => {
  assert.equal(clash("[model_providers.caveman]\n"), "[model_providers.caveman]");
  assert.equal(clash('[ model_providers . "caveman" ]\n'), '[model_providers . "caveman"]');
  assert.equal(clash("[model_providers.caveman.http_headers]\n"), "[model_providers.caveman.http_headers]");
  assert.equal(clash("[profiles.caveman]\n"), "[profiles.caveman]");
  assert.equal(clash('profile = "caveman" # daily driver\n'), 'profile = "caveman"');
  assert.equal(clash("model_providers.caveman.base_url = \"x\"\n"), "model_providers.caveman.base_url");
  assert.equal(clash("[model_providers]\ncaveman = { base_url = \"x\" }\n"), "model_providers.caveman");
  assert.equal(clash("model_providers = { caveman = { base_url = \"x\" } }\n"), "model_providers = { caveman = … }");
});

test("clash: none for look-alikes, other profiles, strings and comments", () => {
  assert.equal(clash("[model_providers.cavemanx]\n[profiles.work]\nprofile = \"work\"\n"), undefined);
  assert.equal(clash("model_providers = { a = { base_url = \"x\" } }\n"), undefined);
  assert.equal(clash("# [model_providers.caveman]\n"), undefined);
  assert.equal(clash('x = """\n[model_providers.caveman]\n"""\n'), undefined);
  assert.equal(clash("x = '''\n[profiles.caveman]\n'''\ny = 2\n"), undefined);
  assert.equal(clash('x = """one line"""\n[profiles.work]\n'), undefined);
});
