// Guards for the two host deployment scripts. They are the scripts the CI workflows and
// the operator's ship scripts run on the host, so the rules they have to keep are checked
// here: the deployment only runs with its confirmation token, the preflight comes first,
// nothing prunes an image or removes a volume, and no secret is printed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEPLOY_DIR } from "./test-harness.mjs";

const dashboard = readFileSync(`${DEPLOY_DIR}/host-dashboard-deploy.sh`, "utf8");
const executor = readFileSync(`${DEPLOY_DIR}/host-executor-deploy.sh`, "utf8");

/** The part of a script that runs after its argument parsing. */
function bodyOf(script) {
  return script.slice(script.indexOf('while [ "$#" -gt 0 ]; do'));
}

describe("the host deployment scripts", () => {
  it("keep the confirmation tokens the deployment scripts demand", () => {
    assert.match(dashboard, /--confirm polytronx-openinspect/);
    assert.match(executor, /--confirm polytronx-executor/);
  });

  it("run the preflight before the deployment", () => {
    const dashboardBody = bodyOf(dashboard);
    const executorBody = bodyOf(executor);
    // The deployment call, not the re-exec of this script in its install mode.
    const dashboardDeploy = dashboardBody.search(/deploy\.sh" --release/);
    const executorDeploy = executorBody.search(/deploy-executor\.sh" --release/);
    assert.notEqual(dashboardDeploy, -1, "the dashboard script must call deploy.sh");
    assert.notEqual(executorDeploy, -1, "the executor script must call deploy-executor.sh");
    assert.ok(
      dashboardBody.indexOf("preflight.sh") < dashboardDeploy,
      "the dashboard preflight must come before the deploy"
    );
    assert.ok(
      executorBody.indexOf("preflight-executor.sh") < executorDeploy,
      "the executor preflight must come before the deploy"
    );
  });

  it("stop after the preflight when the run is not a deployment", () => {
    for (const script of [dashboard, executor]) {
      assert.match(script, /if \[ "\$DEPLOY" != 1 \]; then/);
      assert.match(script, /the preflight passed; nothing was deployed/);
    }
  });

  it("need the revision, and refuse one that is not a commit", () => {
    for (const script of [dashboard, executor]) {
      assert.match(script, /--revision is required/);
      assert.match(script, /\^\[0-9a-f\]\{40\}\$/);
    }
  });

  it("never prune an image, remove a volume or pass --remove-orphans", () => {
    for (const script of [dashboard, executor]) {
      assert.doesNotMatch(script, /docker (image )?prune|docker system prune|volume prune/);
      assert.doesNotMatch(script, /--remove-orphans/);
      assert.doesNotMatch(script, /docker compose[^\n]*\bdown\b[^\n]*\s-v\b/);
      assert.doesNotMatch(script, /rm -rf[^\n]*\/var\/lib\/docker/);
    }
  });

  it("keep the previous tree, the previous release file and the last good release", () => {
    assert.match(dashboard, /source\.bak-\$stamp/);
    assert.match(dashboard, /release\.env\.pre-\$\{REVISION:0:8\}/);
    assert.match(dashboard, /last-good\.env/);
    assert.match(executor, /executor-release\.env\.pre-\$\{REVISION:0:8\}/);
    assert.match(executor, /last-good\.env/);
  });

  it("print no secret value", () => {
    for (const script of [dashboard, executor]) {
      // Nothing reads a secrets file into the output, and no value is echoed from one.
      assert.doesNotMatch(script, /cat[^\n]*secrets/);
      assert.doesNotMatch(script, /echo[^\n]*\$\(cat/);
      assert.doesNotMatch(script, /echo[^\n]*TOKEN/);
      assert.doesNotMatch(script, /echo[^\n]*SECRET/);
    }
  });

  it("keep the executor's own release file apart from the dashboard's", () => {
    assert.match(executor, /executor-release\.env/);
    assert.doesNotMatch(executor, /state\/release\.env/);
    assert.match(dashboard, /\$STATE_DIR\/release\.env/);
  });

  it("builds and records the docs image alongside the dashboard", () => {
    assert.match(dashboard, /docker build --progress=plain -f packages\/docs\/Dockerfile/);
    assert.match(dashboard, /tail -n 80 \/tmp\/polytronx-build-docs\.log/);
    assert.match(dashboard, /set_release_value DOCS_IMAGE /);
    assert.match(dashboard, /set_release_value DOCS_IMAGE_ID /);
    assert.doesNotMatch(dashboard, /prepare_prior_docs_release/);
  });

  it("packages an executable LF control-plane entrypoint", () => {
    const entrypoint = readFileSync(
      new URL("../../packages/control-plane/docker/entrypoint.sh", import.meta.url)
    );
    const attributes = readFileSync(new URL("../../.gitattributes", import.meta.url), "utf8");
    const ignored = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");
    const dockerfile = readFileSync(
      new URL("../../packages/control-plane/Dockerfile", import.meta.url),
      "utf8"
    );

    assert.equal(entrypoint.subarray(0, 10).toString(), "#!/bin/sh\n");
    assert.ok(!entrypoint.includes(13), "CRLF breaks the Linux shebang");
    assert.match(attributes, /^packages\/control-plane\/docker\/entrypoint\.sh text eol=lf\r?$/m);
    assert.match(ignored, /^!packages\/control-plane\/\r?$/m);
    assert.match(
      dockerfile,
      /^COPY --chmod=755 packages\/control-plane\/docker\/entrypoint\.sh \/app\/entrypoint\.sh\r?$/m
    );
    assert.match(dockerfile, /^ENTRYPOINT \["\/app\/entrypoint\.sh"\]\r?$/m);
  });

  it("does not mutate last-good on preflight-only or preflight failure", () => {
    assert.doesNotMatch(dashboard, /set_release_value DOCS_IMAGE [^\n]*\$prior/);
    assert.doesNotMatch(dashboard, /prepare_prior_docs_release/);
    assert.match(dashboard, /if \[ "\$DEPLOY" != 1 \]; then/);
  });
});
