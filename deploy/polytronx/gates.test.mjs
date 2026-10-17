// Guards for the provider cap gate, the Docker data-root disk check, the periodic-backup age,
// and the overlay allowlist in the release workflow. Shell helpers run through lib.sh with
// stubbed curl and docker; nothing contacts Modal or any other provider.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BASH, DEPLOY_DIR, REPO_ROOT, makeSandbox, runSnippet, stubCalls } from "./test-harness.mjs";

const HEALTHY = '{"success":true,"data":{"status":"healthy","max_active_sandboxes":2,"capacity_enforcement":"pre-create"}}';

/** Runs provider_cap_problem against a control-plane.env with the given lines, and a stubbed curl. */
function capGate(sb, { controlPlane = "MODAL_WORKSPACE=acme\n", expect = "2", body = HEALTHY, code = "200", curlExit = "0" } = {}) {
  writeFileSync(`${sb.secrets}/control-plane.env`, controlPlane);
  return runSnippet(sb, `source "${sb.deploy}/lib.sh"; provider_cap_problem "${sb.secrets}/control-plane.env"`, {
    PROVIDER_MAX_ACTIVE_SANDBOXES: expect,
    STUB_CURL_BODY: body,
    STUB_CURL_CODE: code,
    STUB_CURL_EXIT: curlExit,
  });
}

const curlCalls = (sb) => stubCalls(sb).filter((line) => line.startsWith("curl "));

describe("provider cap gate", () => {
  it("passes when the provider reports the expected cap with pre-create enforcement", () => {
    const sb = makeSandbox();
    const result = capGate(sb);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(curlCalls(sb).map((line) => line.split(" ").pop()), [
      "https://acme--open-inspect-api-health.modal.run",
    ]);
  });

  it("accepts spacing and a multi-line body", () => {
    const sb = makeSandbox();
    const result = capGate(sb, { body: '{\n  "max_active_sandboxes": 2,\n  "capacity_enforcement": "pre-create"\n}' });
    assert.equal(result.stdout, "");
  });

  it("refuses a different cap, including 20 for an expected 2", () => {
    const sb = makeSandbox();
    const result = capGate(sb, { body: '{"max_active_sandboxes":20,"capacity_enforcement":"pre-create"}' });
    assert.equal(result.stdout.trim(), "provider does not report max_active_sandboxes=2");
  });

  it("refuses a null cap, a string cap, and a fractional cap", () => {
    for (const value of ["null", '"2"', "2.5"]) {
      const sb = makeSandbox();
      const body = `{"max_active_sandboxes":${value},"capacity_enforcement":"pre-create"}`;
      assert.equal(capGate(sb, { body }).stdout.trim(), "provider does not report max_active_sandboxes=2", body);
    }
  });

  it("refuses a provider that reports the cap without pre-create enforcement", () => {
    const sb = makeSandbox();
    const result = capGate(sb, { body: '{"max_active_sandboxes":2,"capacity_enforcement":"disabled"}' });
    assert.equal(result.stdout.trim(), "provider does not report capacity_enforcement pre-create");
  });

  it("refuses an older endpoint that reports neither field", () => {
    const sb = makeSandbox();
    const result = capGate(sb, { body: '{"success":true,"data":{"status":"healthy"}}' });
    assert.equal(result.stdout.trim(), "provider does not report max_active_sandboxes=2");
  });

  it("refuses an unavailable provider, and one that cannot be reached", () => {
    const unavailable = makeSandbox();
    assert.equal(capGate(unavailable, { code: "503", body: HEALTHY }).stdout.trim(), "provider health answered HTTP 503");
    const unreachable = makeSandbox();
    assert.equal(capGate(unreachable, { code: "000", curlExit: "7", body: "" }).stdout.trim(), "provider health answered HTTP 000");
  });

  it("refuses when the expected cap is not a positive integer, without calling the provider", () => {
    const sb = makeSandbox();
    assert.equal(capGate(sb, { expect: "0" }).stdout.trim(), "PROVIDER_MAX_ACTIVE_SANDBOXES in pins.env is not a positive integer");
    assert.deepEqual(curlCalls(sb), []);
  });

  it("refuses a provider that reports a different expected cap", () => {
    const sb = makeSandbox();
    assert.equal(capGate(sb, { expect: "3" }).stdout.trim(), "provider does not report max_active_sandboxes=3");
  });

  it("uses MODAL_API_URL when the control plane does", () => {
    const sb = makeSandbox();
    const result = capGate(sb, { controlPlane: "MODAL_WORKSPACE=acme\nMODAL_API_URL=https://modal.example.test/\n" });
    assert.equal(result.stdout, "");
    assert.deepEqual(curlCalls(sb).map((line) => line.split(" ").pop()), ["https://modal.example.test/api-health"]);
  });

  it("derives the environment suffix the way the control plane does", () => {
    const sb = makeSandbox();
    capGate(sb, { controlPlane: "MODAL_WORKSPACE=acme\nMODAL_ENVIRONMENT_WEB_SUFFIX=prod\n" });
    assert.deepEqual(curlCalls(sb).map((line) => line.split(" ").pop()), [
      "https://acme-prod--open-inspect-api-health.modal.run",
    ]);
  });

  it("refuses to guess a URL when the workspace is missing", () => {
    const sb = makeSandbox();
    const result = capGate(sb, { controlPlane: "MODAL_API_SECRET=placeholder\n" });
    assert.equal(result.stdout.trim(), "MODAL_WORKSPACE is not set, so the provider health URL cannot be derived");
    assert.deepEqual(curlCalls(sb), []);
  });

  it("sends no credential: the request line carries no secret value", () => {
    const sb = makeSandbox();
    capGate(sb, { controlPlane: "MODAL_WORKSPACE=acme\nMODAL_API_SECRET=do-not-send-this-value\n" });
    const request = curlCalls(sb).join("\n");
    assert.doesNotMatch(request, /do-not-send-this-value/);
    assert.doesNotMatch(request, /Authorization|-H /);
  });
});

describe("disk check on the engine's data root", () => {
  it("measures the filesystem the engine reports, not /var/lib/docker", () => {
    const sb = makeSandbox();
    const result = runSnippet(sb, `source "${sb.deploy}/lib.sh"; docker_root_free_kb`, {
      STUB_DOCKER_ROOT: "/mnt/docker-data",
      STUB_DF_FREE_KB: "12345",
    });
    assert.equal(result.stdout.trim(), "12345");
    assert.ok(stubCalls(sb).includes("df -Pk /mnt/docker-data"), stubCalls(sb).join("\n"));
    assert.equal(stubCalls(sb).some((line) => line.includes("/var/lib/docker")), false);
  });

  it("reads nothing, rather than guessing, when the engine gives no data root", () => {
    const sb = makeSandbox();
    const result = runSnippet(sb, `source "${sb.deploy}/lib.sh"; docker_root_free_kb`, { STUB_DOCKER_ROOT: "" });
    assert.equal(result.stdout.trim(), "");
    assert.equal(stubCalls(sb).some((line) => line.startsWith("df ")), false);
  });
});

describe("periodic backup age", () => {
  it("ages only the newest periodic-* backup", () => {
    const sb = makeSandbox();
    const dir = `${sb.root}/backups`;
    const now = Date.now() / 1000;
    for (const [name, hoursAgo] of [["periodic-20261010T032000Z", 100], ["periodic-20261015T032000Z", 5], ["manual-20261016T000000Z", 0]]) {
      mkdirSync(`${dir}/${name}`, { recursive: true });
      utimesSync(`${dir}/${name}`, now - hoursAgo * 3600, now - hoursAgo * 3600);
    }
    const result = runSnippet(sb, `source "${sb.deploy}/lib.sh"; newest_periodic_backup_age_hours "${dir}"`);
    assert.equal(result.stdout.trim(), "5");
  });

  it("reports nothing when no periodic backup exists", () => {
    const sb = makeSandbox();
    mkdirSync(`${sb.root}/backups/manual-20261016T000000Z`, { recursive: true });
    const result = runSnippet(sb, `source "${sb.deploy}/lib.sh"; newest_periodic_backup_age_hours "${sb.root}/backups"`);
    assert.equal(result.stdout.trim(), "");
  });
});

describe("overlay allowlist in the release workflow", () => {
  const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/polytronx-openinspect.yml`, "utf8");
  const allowed = /allowed='([^']+)'/.exec(workflow)[1];

  /** The paths grep -Ev keeps: the ones the workflow would refuse as upstream changes. */
  function refused(paths) {
    const result = spawnSync(BASH, ["-c", String.raw`printf '%s\n' "$PATHS" | grep -Ev "$ALLOWED" || true`], {
      encoding: "utf8",
      env: { ...process.env, PATHS: paths.join("\n"), ALLOWED: allowed },
    });
    return result.stdout.split("\n").filter(Boolean);
  }

  it("accepts every path that differs from the upstream pin in this checkout", () => {
    // The workflow's own diff, read from git rather than copied here, so a path the overlay adds
    // cannot pass this test while the workflow refuses it.
    const gitLines = (...args) =>
      execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const pin = /^UPSTREAM_REVISION=([0-9a-f]{40})$/m.exec(readFileSync(`${DEPLOY_DIR}/pins.env`, "utf8"))[1];
    const changed = [
      ...gitLines("diff", "--name-only", "--no-renames", pin),
      ...gitLines("ls-files", "--others", "--exclude-standard"),
    ];
    assert.ok(changed.length > 0, "the checkout should differ from the pin by the overlay");
    assert.deepEqual(refused(changed), []);
  });

  it("refuses a nested .gitignore, and upstream or neighbouring paths", () => {
    assert.ok(allowed.startsWith("^("), "the outer start anchor is what makes the .gitignore alternative exact");
    assert.deepEqual(refused([
      "foo/.gitignore",
      "packages/web/.gitignore",
      "packages/control-plane/src/index.ts",
      "scripts/bootstrap-workspace-owner.ts",
      "scripts/tsconfig.json",
      "packages/modal-infra/src/app.py",
      "packages/modal-infra/src/web_api.py.orig",
      "packages/modal-infra/tests/test_sandbox_capacity.py.bak",
      "packages/web/Dockerfile.bak",
      ".github/workflows/ci.yml",
      "xdeploy/polytronx/backup.sh",
      "deploy/polytronx-backup/backup.sh",
    ]), [
      "foo/.gitignore",
      "packages/web/.gitignore",
      "packages/control-plane/src/index.ts",
      "scripts/bootstrap-workspace-owner.ts",
      "scripts/tsconfig.json",
      "packages/modal-infra/src/app.py",
      "packages/modal-infra/src/web_api.py.orig",
      "packages/modal-infra/tests/test_sandbox_capacity.py.bak",
      "packages/web/Dockerfile.bak",
      ".github/workflows/ci.yml",
      "xdeploy/polytronx/backup.sh",
      "deploy/polytronx-backup/backup.sh",
    ]);
  });
});

describe("release job gating in the workflow", () => {
  it("the images job needs every other job, so a failed check cannot still produce the artifact", () => {
    const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/polytronx-openinspect.yml`, "utf8");
    const jobs = workflow.slice(workflow.indexOf("\njobs:"));
    const jobNames = [...jobs.matchAll(/^  ([a-z][a-z-]*):$/gm)].map((match) => match[1]);
    const needs = /^    needs: \[([^\]]*)\]$/m.exec(jobs.slice(jobs.indexOf("\n  images:")))[1];
    assert.deepEqual(
      needs.split(",").map((name) => name.trim()).sort(),
      jobNames.filter((name) => name !== "images").sort(),
    );
  });
});

describe("pinned third-party images", () => {
  const pins = readFileSync(`${DEPLOY_DIR}/pins.env`, "utf8");
  const compose = readFileSync(`${DEPLOY_DIR}/compose.production.yml`, "utf8");
  // Literal image references in the compose file. A ${...} reference is the release's own image.
  const composeImages = [...compose.matchAll(/^\s+image: (?!\$\{)(\S+)$/gm)].map((match) => match[1]);
  const pinnedValues = new Set(pins.split("\n").map((line) => line.split("=")[1]));

  /** The first problem lib.sh reports for the sandbox's pins.env, as preflight would. */
  function thirdPartyProblem(sb, env = {}) {
    const snippet = `source "${sb.deploy}/lib.sh"; load_release_file "${sb.deploy}/pins.env"; third_party_image_problem`;
    return runSnippet(sb, snippet, env).stdout.trim();
  }

  it("every third-party image in the compose file is a value pins.env records", () => {
    assert.ok(composeImages.length > 0, "the compose file should name third-party images");
    for (const ref of composeImages) assert.ok(pinnedValues.has(ref), `${ref} is not in pins.env`);
  });

  it("the pull step fetches every third-party image the compose file names, and only when missing", () => {
    const sb = makeSandbox();
    const pull = `source "${sb.deploy}/lib.sh"; load_release_file "${sb.deploy}/pins.env"; pull_third_party_images`;
    const result = runSnippet(sb, pull, { STUB_IMAGE_MISSING: "1" });
    assert.equal(result.status, 0, result.stderr);
    const pulled = stubCalls(sb)
      .filter((line) => line.startsWith("docker pull "))
      .map((line) => line.slice("docker pull ".length));
    assert.deepEqual(pulled.sort(), [...composeImages].sort());

    const present = makeSandbox();
    runSnippet(present, `source "${present.deploy}/lib.sh"; load_release_file "${present.deploy}/pins.env"; pull_third_party_images`);
    assert.equal(stubCalls(present).some((line) => line.startsWith("docker pull ")), false);
  });

  it("reports nothing when each pinned image is on the host with its digest", () => {
    assert.equal(thirdPartyProblem(makeSandbox()), "");
  });

  it("reports a missing image, or one without its pinned digest", () => {
    const missing = thirdPartyProblem(makeSandbox(), { STUB_IMAGE_MISSING: "1" });
    assert.match(missing, /is not on this host with its pinned digest/);
    const undigested = thirdPartyProblem(makeSandbox(), { STUB_REPO_DIGEST: "" });
    assert.match(undigested, /is not on this host with its pinned digest/);
  });

  it("reports a pins.env value that is not pinned by digest", () => {
    const sb = makeSandbox();
    const unpinned = pins.replace(/^LITESTREAM_IMAGE=.*$/m, "LITESTREAM_IMAGE=litestream/litestream:0.3.13");
    writeFileSync(`${sb.deploy}/pins.env`, unpinned);
    assert.equal(thirdPartyProblem(sb), "LITESTREAM_IMAGE in pins.env is not pinned by digest");
  });
});
