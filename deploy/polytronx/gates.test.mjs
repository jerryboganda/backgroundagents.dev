// Guards for the provider cap gate, the Docker data-root disk check, the periodic-backup age,
// and the overlay allowlist and credential refusal in the release workflow, and the executor CA mount and its preflight check. Shell helpers run through lib.sh with
// stubbed curl and docker; nothing contacts Modal or any other provider.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import {
  BASH,
  DEPLOY_DIR,
  REPO_ROOT,
  makeSandbox,
  runScript,
  runSnippet,
  stubCalls,
  writeRelease,
} from "./test-harness.mjs";

const HEALTHY =
  '{"success":true,"data":{"status":"healthy","max_active_sandboxes":2,"capacity_enforcement":"pre-create"}}';
const WORKFLOW = readFileSync(`${REPO_ROOT}/.github/workflows/polytronx-openinspect.yml`, "utf8");

/** The shell script of one workflow step, with the YAML block indentation removed. */
function workflowStep(name) {
  const lines = WORKFLOW.split(/\r?\n/);
  const start = lines.indexOf(`      - name: ${name}`);
  assert.notEqual(start, -1, `no step named ${name}`);
  const run = lines.indexOf("        run: |", start);
  assert.notEqual(run, -1, `step ${name} has no run block`);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line !== "" && !line.startsWith(" ".repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

/** Runs provider_cap_problem against a control-plane.env with the given lines, and a stubbed curl. */
function capGate(
  sb,
  {
    controlPlane = "MODAL_WORKSPACE=acme\n",
    expect = "2",
    body = HEALTHY,
    code = "200",
    curlExit = "0",
  } = {}
) {
  writeFileSync(`${sb.secrets}/control-plane.env`, controlPlane);
  return runSnippet(
    sb,
    `source "${sb.deploy}/lib.sh"; provider_cap_problem "${sb.secrets}/control-plane.env"`,
    {
      PROVIDER_MAX_ACTIVE_SANDBOXES: expect,
      STUB_CURL_BODY: body,
      STUB_CURL_CODE: code,
      STUB_CURL_EXIT: curlExit,
    }
  );
}

const curlCalls = (sb) => stubCalls(sb).filter((line) => line.startsWith("curl "));

describe("provider cap gate", () => {
  it("passes when the provider reports the expected cap with pre-create enforcement", () => {
    const sb = makeSandbox();
    const result = capGate(sb);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(
      curlCalls(sb).map((line) => line.split(" ").pop()),
      ["https://acme--open-inspect-api-health.modal.run"]
    );
  });

  it("accepts spacing and a multi-line body", () => {
    const sb = makeSandbox();
    const result = capGate(sb, {
      body: '{\n  "max_active_sandboxes": 2,\n  "capacity_enforcement": "pre-create"\n}',
    });
    assert.equal(result.stdout, "");
  });

  it("refuses a different cap, including 20 for an expected 2", () => {
    const sb = makeSandbox();
    const result = capGate(sb, {
      body: '{"max_active_sandboxes":20,"capacity_enforcement":"pre-create"}',
    });
    assert.equal(result.stdout.trim(), "provider does not report max_active_sandboxes=2");
  });

  it("refuses a null cap, a string cap, and a fractional cap", () => {
    for (const value of ["null", '"2"', "2.5"]) {
      const sb = makeSandbox();
      const body = `{"max_active_sandboxes":${value},"capacity_enforcement":"pre-create"}`;
      assert.equal(
        capGate(sb, { body }).stdout.trim(),
        "provider does not report max_active_sandboxes=2",
        body
      );
    }
  });

  it("refuses a provider that reports the cap without pre-create enforcement", () => {
    const sb = makeSandbox();
    const result = capGate(sb, {
      body: '{"max_active_sandboxes":2,"capacity_enforcement":"disabled"}',
    });
    assert.equal(result.stdout.trim(), "provider does not report capacity_enforcement pre-create");
  });

  it("refuses an older endpoint that reports neither field", () => {
    const sb = makeSandbox();
    const result = capGate(sb, { body: '{"success":true,"data":{"status":"healthy"}}' });
    assert.equal(result.stdout.trim(), "provider does not report max_active_sandboxes=2");
  });

  it("refuses an unavailable provider, and one that cannot be reached", () => {
    const unavailable = makeSandbox();
    assert.equal(
      capGate(unavailable, { code: "503", body: HEALTHY }).stdout.trim(),
      "provider health answered HTTP 503"
    );
    const unreachable = makeSandbox();
    assert.equal(
      capGate(unreachable, { code: "000", curlExit: "7", body: "" }).stdout.trim(),
      "provider health answered HTTP 000"
    );
  });

  it("refuses when the expected cap is not a positive integer, without calling the provider", () => {
    const sb = makeSandbox();
    assert.equal(
      capGate(sb, { expect: "0" }).stdout.trim(),
      "PROVIDER_MAX_ACTIVE_SANDBOXES in pins.env is not a positive integer"
    );
    assert.deepEqual(curlCalls(sb), []);
  });

  it("refuses a provider that reports a different expected cap", () => {
    const sb = makeSandbox();
    assert.equal(
      capGate(sb, { expect: "3" }).stdout.trim(),
      "provider does not report max_active_sandboxes=3"
    );
  });

  it("uses MODAL_API_URL when the control plane does", () => {
    const sb = makeSandbox();
    const result = capGate(sb, {
      controlPlane: "MODAL_WORKSPACE=acme\nMODAL_API_URL=https://modal.example.test/\n",
    });
    assert.equal(result.stdout, "");
    assert.deepEqual(
      curlCalls(sb).map((line) => line.split(" ").pop()),
      ["https://modal.example.test/api-health"]
    );
  });

  it("derives the environment suffix the way the control plane does", () => {
    const sb = makeSandbox();
    capGate(sb, { controlPlane: "MODAL_WORKSPACE=acme\nMODAL_ENVIRONMENT_WEB_SUFFIX=prod\n" });
    assert.deepEqual(
      curlCalls(sb).map((line) => line.split(" ").pop()),
      ["https://acme-prod--open-inspect-api-health.modal.run"]
    );
  });

  it("refuses to guess a URL when the workspace is missing", () => {
    const sb = makeSandbox();
    const result = capGate(sb, { controlPlane: "MODAL_API_SECRET=placeholder\n" });
    assert.equal(
      result.stdout.trim(),
      "MODAL_WORKSPACE is not set, so the provider health URL cannot be derived"
    );
    assert.deepEqual(curlCalls(sb), []);
  });

  it("sends no credential: the request line carries no secret value", () => {
    const sb = makeSandbox();
    capGate(sb, {
      controlPlane: "MODAL_WORKSPACE=acme\nMODAL_API_SECRET=do-not-send-this-value\n",
    });
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
    assert.equal(
      stubCalls(sb).some((line) => line.includes("/var/lib/docker")),
      false
    );
  });

  it("reads nothing, rather than guessing, when the engine gives no data root", () => {
    const sb = makeSandbox();
    const result = runSnippet(sb, `source "${sb.deploy}/lib.sh"; docker_root_free_kb`, {
      STUB_DOCKER_ROOT: "",
    });
    assert.equal(result.stdout.trim(), "");
    assert.equal(
      stubCalls(sb).some((line) => line.startsWith("df ")),
      false
    );
  });
});

describe("periodic backup age", () => {
  it("ages only the newest periodic-* backup", () => {
    const sb = makeSandbox();
    const dir = `${sb.root}/backups`;
    const now = Date.now() / 1000;
    for (const [name, hoursAgo] of [
      ["periodic-20261010T032000Z", 100],
      ["periodic-20261015T032000Z", 5],
      ["manual-20261016T000000Z", 0],
    ]) {
      mkdirSync(`${dir}/${name}`, { recursive: true });
      utimesSync(`${dir}/${name}`, now - hoursAgo * 3600, now - hoursAgo * 3600);
    }
    const result = runSnippet(
      sb,
      `source "${sb.deploy}/lib.sh"; newest_periodic_backup_age_hours "${dir}"`
    );
    assert.equal(result.stdout.trim(), "5");
  });

  it("reports nothing when no periodic backup exists", () => {
    const sb = makeSandbox();
    mkdirSync(`${sb.root}/backups/manual-20261016T000000Z`, { recursive: true });
    const result = runSnippet(
      sb,
      `source "${sb.deploy}/lib.sh"; newest_periodic_backup_age_hours "${sb.root}/backups"`
    );
    assert.equal(result.stdout.trim(), "");
  });
});

describe("overlay allowlist in the release workflow", () => {
  const allowed = /allowed='([^']+)'/.exec(WORKFLOW)[1];
  // Stands in for git in the step: `git diff` prints the paths under test, and the other calls succeed.
  const gitDiffStub = `#!/usr/bin/env bash
if [ "$1" = diff ] && [ -n "$CHANGED_PATHS" ]; then printf '%s\\n' "$CHANGED_PATHS"; fi
exit 0
`;

  /** Runs the workflow's own pin-and-overlay step with `paths` as the committed diff. */
  function runAdmission(paths, pin = "a".repeat(40)) {
    const sb = makeSandbox();
    mkdirSync(`${sb.root}/deploy/polytronx`, { recursive: true });
    writeFileSync(`${sb.root}/deploy/polytronx/pins.env`, `UPSTREAM_REVISION=${pin}\n`);
    writeFileSync(`${sb.bin}/git`, gitDiffStub);
    chmodSync(`${sb.bin}/git`, 0o755);
    return runSnippet(sb, workflowStep("Check the upstream pin and the overlay"), {
      CHANGED_PATHS: paths.join("\n"),
    });
  }

  /**
   * The paths the workflow's step refuses, credential or allowlist, in the order given. A step that
   * stops before the allowlist prints no path, so it fails here instead of reading as an admission.
   */
  function refused(paths, pin) {
    const result = runAdmission(paths, pin);
    assert.match(
      result.stdout,
      /intact; \d+ overlay path|credential paths differ from the upstream pin|paths differ from the upstream pin outside the overlay/,
      `the step stopped before the allowlist (status ${result.status}):\n${result.stdout}${result.stderr}`
    );
    const printed = result.stdout.split("\n");
    return paths.filter((path) => printed.includes(path));
  }

  /** The paths the allowlist alone would refuse, with no credential check: a control for the tests below. */
  function refusedByAllowlist(paths) {
    const result = spawnSync(
      BASH,
      ["-c", String.raw`printf '%s\n' "$PATHS" | grep -Ev "$ALLOWED" || true`],
      {
        encoding: "utf8",
        env: { ...process.env, PATHS: paths.join("\n"), ALLOWED: allowed },
      }
    );
    return result.stdout.split("\n").filter(Boolean);
  }

  it("does not read a step that stops before the allowlist as an admission", () => {
    // A pin that is not a commit ends the step before any path is checked, so it prints no path.
    const paths = ["packages/web/src/components/button.tsx"];
    const stopped = runAdmission(paths, "not-a-commit");
    assert.equal(stopped.status, 1, stopped.stdout);
    assert.match(stopped.stdout, /not a full commit/);
    assert.throws(() => refused(paths, "not-a-commit"), /stopped before the allowlist/);
  });

  it("admits exactly the 0090 migration, the secrets editor, and the secrets-validation and sandbox-env files, each by its full path", () => {
    // Exact paths, no directory prefix: a file beside them is refused until it is listed too.
    const admitted = [
      "terraform/d1/migrations/0090_sandbox_admission_relinquished.sql",
      "packages/web/src/components/secrets-editor.tsx",
      "packages/web/src/components/secrets-editor.test.ts",
      "packages/control-plane/src/db/secrets-validation.ts",
      "packages/control-plane/src/db/secrets-validation.test.ts",
      "packages/control-plane/src/sandbox/sandbox-env.ts",
    ];
    const result = runAdmission(admitted);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /intact/);
  });

  it("refuses the neighbours of the 0090 migration, the secrets editor, and the secrets-validation and sandbox-env files", () => {
    const neighbours = [
      "terraform/d1/migrations/0090_sandbox_admission_relinquished.sql.bak",
      "terraform/d1/migrations/0090_sandbox_admission_relinquished.sql.orig",
      "terraform/d1/migrations/0091_sandbox_admission_relinquished.sql",
      "terraform/d1/migrations/0091_next.sql",
      "x/terraform/d1/migrations/0090_sandbox_admission_relinquished.sql",
      "packages/web/src/components/secrets-editor.tsx.orig",
      "packages/web/src/components/secrets-editor.test.tsx",
      "packages/web/src/components/secrets-editor.test.ts.bak",
      "packages/web/src/components/secrets-editor.ts",
      "packages/web/src/components/SecretsEditor.tsx",
      "packages/web/src/components/button.tsx",
      "packages/web/src/components/index.ts",
      "packages/web/src/secrets-editor.tsx",
      "packages/control-plane/src/db/secrets-validation.ts.bak",
      "packages/control-plane/src/db/secrets-validation.test.tsx",
      "packages/control-plane/src/db/secrets-validation.orig.ts",
      "packages/control-plane/src/sandbox/sandbox-env.ts.orig",
      "packages/control-plane/src/sandbox/sandbox-env.test.ts",
      "x/packages/control-plane/src/sandbox/sandbox-env.ts",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("refuses credential paths beside the 0090 migration and the web secrets editor files", () => {
    const credentials = [
      "terraform/d1/migrations/.env",
      "terraform/d1/migrations/0090_sandbox_admission_relinquished.sql.tfstate",
      "packages/web/src/components/.env.local",
      "packages/web/src/components/secrets/editor.tsx",
      "packages/web/src/components/secrets-editor.tsx.pem",
      "packages/web/src/components/secrets-editor.test.ts.key",
    ];
    const result = runAdmission(credentials);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /credential paths differ from the upstream pin/);
    assert.deepEqual(refused(credentials), credentials);
  });

  it("accepts every path that differs from the upstream pin in this checkout", () => {
    // The workflow's own diff, read from git rather than copied here, so a path the overlay adds
    // cannot pass this test while the workflow refuses it.
    const gitLines = (...args) =>
      execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const pin = /^UPSTREAM_REVISION=([0-9a-f]{40})$/m.exec(
      readFileSync(`${DEPLOY_DIR}/pins.env`, "utf8")
    )[1];
    const changed = [
      ...gitLines("diff", "--name-only", "--no-renames", pin),
      ...gitLines("ls-files", "--others", "--exclude-standard"),
    ];
    assert.ok(changed.length > 0, "the checkout should differ from the pin by the overlay");
    assert.deepEqual(refused(changed), []);
  });

  it("admits exactly the control-plane secrets routes and their tests, each by its full path", () => {
    // Exact paths, no directory prefix: a file beside them is refused until it is listed too.
    const admitted = [
      "packages/control-plane/src/db/team-secrets.ts",
      "packages/control-plane/src/routes/environment-secrets.ts",
      "packages/control-plane/src/routes/secrets.ts",
      "packages/control-plane/src/routes/secrets.repository-grants.test.ts",
      "packages/control-plane/test/integration/environments-routes.test.ts",
      "packages/control-plane/test/integration/global-secrets.test.ts",
      "packages/control-plane/test/integration/team-secrets-routes.test.ts",
    ];
    const result = runAdmission(admitted);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /intact/);
  });

  it("refuses the neighbours of the control-plane secrets routes and their tests", () => {
    const neighbours = [
      "packages/control-plane/src/routes/secrets.ts.orig",
      "packages/control-plane/src/routes/secrets.test.ts",
      "packages/control-plane/src/routes/secrets.repository-grants.ts",
      "packages/control-plane/src/routes/secrets.repository-grants.test.tsx",
      "packages/control-plane/src/routes/environment-secrets.test.ts",
      "packages/control-plane/src/routes/Secrets.ts",
      "packages/control-plane/src/db/team-secrets.test.ts",
      "packages/control-plane/src/db/team-secrets.ts.bak",
      "packages/control-plane/test/integration/global-secrets.test.ts.orig",
      "packages/control-plane/test/integration/global-secrets.ts",
      "packages/control-plane/test/integration/team-secrets-routes.test.tsx",
      "packages/control-plane/test/integration/environments-routes.test.ts.bak",
      "x/packages/control-plane/src/routes/secrets.ts",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("refuses credential paths beside the control-plane secrets routes", () => {
    const credentials = [
      "packages/control-plane/src/routes/secrets/index.ts",
      "packages/control-plane/src/routes/secrets.ts.pem",
      "packages/control-plane/src/db/team-secrets.ts.tfstate",
      "packages/control-plane/test/integration/global-secrets.test.ts.key",
      "packages/control-plane/test/integration/.env.test",
    ];
    const result = runAdmission(credentials);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /credential paths differ from the upstream pin/);
    assert.deepEqual(refused(credentials), credentials);
  });

  it("admits exactly the environment secrets store and its test, each by its full path", () => {
    // Exact paths, no directory prefix: a file beside them is refused until it is listed too.
    const admitted = [
      "packages/control-plane/src/db/environment-secrets.ts",
      "packages/control-plane/src/db/environment-secrets.test.ts",
    ];
    const result = runAdmission(admitted);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /intact/);
  });

  it("refuses the neighbours of the environment secrets store and its test", () => {
    const neighbours = [
      "packages/control-plane/src/db/environment-secrets.ts.orig",
      "packages/control-plane/src/db/environment-secrets.test.ts.bak",
      "packages/control-plane/src/db/environment-secrets.test.tsx",
      "packages/control-plane/src/db/environment-secrets.tsx",
      "packages/control-plane/src/db/environment-secrets.spec.ts",
      "packages/control-plane/src/db/environment-secrets-helpers.ts",
      "packages/control-plane/src/db/environment-secrets/index.ts",
      "packages/control-plane/src/db/Environment-Secrets.ts",
      "packages/control-plane/src/db/repo-environment-secrets.ts",
      "x/packages/control-plane/src/db/environment-secrets.ts",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("refuses credential paths beside the environment secrets store and its test", () => {
    const credentials = [
      "packages/control-plane/src/db/.env.local",
      "packages/control-plane/src/db/environment-secrets.ts.pem",
      "packages/control-plane/src/db/environment-secrets.test.ts.key",
      "packages/control-plane/src/db/environment-secrets.ts.tfstate",
      "packages/control-plane/src/db/secrets/environment-secrets.ts",
    ];
    const result = runAdmission(credentials);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /credential paths differ from the upstream pin/);
    assert.deepEqual(refused(credentials), credentials);
  });

  it("admits exactly the executor files outside its package", () => {
    // Each path is named, so a file added beside them is refused until it is listed too.
    assert.deepEqual(
      refused([
        "packages/control-plane/src/node/config.ts",
        "packages/control-plane/src/types.ts",
        "packages/control-plane/src/sandbox/provider.ts",
        "packages/control-plane/src/sandbox/provider-factory.ts",
        "packages/control-plane/src/sandbox/provider-factory.test.ts",
        "packages/control-plane/src/sandbox/lifecycle/manager.ts",
        "packages/control-plane/src/sandbox/lifecycle/vm-startup-reconciliation.ts",
        "packages/control-plane/src/sandbox/admission/gate.ts",
        "packages/control-plane/src/sandbox/admission/gate.test.ts",
        "packages/control-plane/src/sandbox/admission/manager-admission.test.ts",
        "packages/control-plane/src/sandbox/admission/reservations.ts",
        "packages/control-plane/src/sandbox/admission/reservations.test.ts",
        "packages/control-plane/src/sandbox/providers/vps-provider.ts",
        "packages/control-plane/src/sandbox/providers/vps-provider.test.ts",
        "packages/control-plane/test/integration/cleanup.ts",
        "packages/shared/src/types/integrations.ts",
        "terraform/d1/migrations/0089_sandbox_admission_reservations.sql",
        "package-lock.json",
      ]),
      []
    );
  });

  it("refuses the neighbours of the executor files outside its package", () => {
    const neighbours = [
      "packages/control-plane/src/sandbox/admission/index.ts",
      "packages/control-plane/src/sandbox/admission/manager-admission.ts",
      "packages/control-plane/src/sandbox/admission/gate.ts.orig",
      "packages/control-plane/src/sandbox/admission/reservations.test.ts.bak",
      "packages/control-plane/src/sandbox/providers/modal-provider.ts",
      "packages/control-plane/src/sandbox/providers/vps-provider.ts.orig",
      "packages/control-plane/src/sandbox/lifecycle/manager.test.ts",
      "packages/control-plane/src/sandbox/provider.test.ts",
      "packages/control-plane/src/sandbox/types.ts",
      "packages/control-plane/src/node/server.ts",
      "packages/control-plane/src/types.ts.orig",
      "packages/control-plane/test/integration/cleanup.test.ts",
      "packages/shared/src/types/index.ts",
      "packages/web/package-lock.json",
      "terraform/d1/migrations/0089_sandbox_admission_reservations.sql.bak",
      "terraform/d1/migrations/0090_next.sql",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("admits exactly the other control-plane files the overlay changes, each by its full path", () => {
    // Named by full path, with no packages/control-plane prefix: a file beside them is refused until it is listed.
    assert.deepEqual(
      refused([
        "packages/control-plane/src/sandbox/admission/vps-reconcile.ts",
        "packages/control-plane/src/sandbox/admission/vps-reconcile.test.ts",
        "packages/control-plane/src/sandbox/providers/pending-vm-reference.ts",
        "packages/control-plane/src/scheduled-jobs.ts",
        "packages/control-plane/src/scheduled-jobs.test.ts",
        "packages/control-plane/src/session/components.ts",
        "packages/control-plane/src/session/components-admission.test.ts",
      ]),
      []
    );
  });

  it("refuses the neighbours of those control-plane files", () => {
    const neighbours = [
      "packages/control-plane/src/sandbox/admission/vps-reconcile.ts.orig",
      "packages/control-plane/src/sandbox/admission/vps-reconcile-helpers.ts",
      "packages/control-plane/src/sandbox/admission/vps-reconcile.test.ts.bak",
      "packages/control-plane/src/sandbox/providers/pending-vm-reference.test.ts",
      "packages/control-plane/src/sandbox/providers/pending-vm-reference.ts.bak",
      "packages/control-plane/src/scheduled-jobs-admission.ts",
      "packages/control-plane/src/scheduled-jobs.ts.orig",
      "packages/control-plane/src/scheduled-jobs.test.ts.bak",
      "packages/control-plane/src/session/components.test.ts",
      "packages/control-plane/src/session/components-admission.ts",
      "packages/control-plane/src/session/components.ts.orig",
      "packages/control-plane/src/session/index.ts",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("admits the shutdown files by full path, and refuses their neighbours", () => {
    assert.deepEqual(
      refused([
        "packages/control-plane/src/session/sandbox-shutdown.ts",
        "packages/control-plane/src/session/sandbox-shutdown.test.ts",
      ]),
      []
    );
    const neighbours = [
      "packages/control-plane/src/session/sandbox-shutdown.ts.orig",
      "packages/control-plane/src/session/sandbox-shutdown-helpers.ts",
      "packages/control-plane/src/session/sandbox-shutdown.test.ts.bak",
      "packages/control-plane/src/session/index.ts",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("refuses a nested .gitignore, and upstream or neighbouring paths", () => {
    assert.ok(
      allowed.startsWith("^("),
      "the outer start anchor is what makes the .gitignore alternative exact"
    );
    assert.deepEqual(
      refused([
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
      ]),
      [
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
      ]
    );
  });

  it("admits the root .env.example template and .gitattributes by exact name only", () => {
    assert.deepEqual(refused([".env.example", ".gitattributes"]), []);
    // Real env files and near misses of the two admitted names stay refused.
    const neighbours = [
      ".env",
      ".env.local",
      ".env.production",
      "packages/web/.env.example",
      ".env.example.bak",
      "x.env.example",
      "packages/web/.gitattributes",
      ".gitattributes.bak",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("refuses credential paths under the overlay's own directories, which the allowlist alone admits", () => {
    const credentials = [
      "deploy/polytronx/.env",
      "deploy/polytronx/.env.production",
      "deploy/polytronx/.env.example",
      "deploy/polytronx/.dev.vars",
      "deploy/polytronx/control-plane.env",
      "deploy/polytronx/secrets/control-plane.env",
      "deploy/polytronx/tls/edge.key",
      "deploy/polytronx/edge.pem",
      "deploy/polytronx/id_ed25519",
      "deploy/polytronx/auth.json",
      "deploy/polytronx/.npmrc",
      "deploy/polytronx/ci-token.txt",
      "deploy/polytronx/terraform.tfvars",
      "deploy/polytronx/state/terraform.tfstate.backup",
      "deploy/polytronx/.ssh/config",
      "packages/vps-executor/.env",
      "packages/vps-executor/.env.local",
      "packages/vps-executor/secrets/executor.env",
    ];
    assert.deepEqual(refusedByAllowlist(credentials), [], "the allowlist alone would admit these");
    const result = runAdmission(credentials);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /credential paths differ from the upstream pin/);
    assert.deepEqual(refused(credentials), credentials);
  });

  it("refuses any other *.env under the overlay, in any letter case, and admits only the exact pins.env", () => {
    // The allowlist alone admits these, so the credential guard is what refuses them.
    const envFiles = [
      "deploy/polytronx/backup.env",
      "deploy/polytronx/Backup.ENV",
      "packages/vps-executor/executor.env",
    ];
    assert.deepEqual(refusedByAllowlist(envFiles), [], "the allowlist alone would admit these");
    assert.deepEqual(refused(envFiles), envFiles);
    assert.deepEqual(refused(["deploy/polytronx/pins.env"]), []);
  });

  it("refuses credential paths at the root, and root near misses of the template", () => {
    const root = [
      ".env",
      ".env.local",
      ".env.production",
      ".env.examples",
      ".env.example.bak",
      ".dev.vars",
      "pins.env",
    ];
    assert.deepEqual(refused(root), root);
  });

  it("admits the overlay's pins, nonsecret task templates, and names that only look like credentials", () => {
    const legitimate = [
      ".env.example",
      "deploy/polytronx/pins.env",
      "deploy/polytronx/templates/control-plane.env.template",
      "deploy/polytronx/templates/release.env.template",
      "deploy/polytronx/templates/storage.env.template",
      "deploy/polytronx/templates/web.env.template",
      "deploy/polytronx/environment-notes.md",
      "deploy/polytronx/keyed-rollout.md",
      "deploy/polytronx/oauth.json",
      "deploy/polytronx/secrets-policy.md",
      "deploy/polytronx/tokens-policy.md",
      "packages/vps-executor/src/secrets.ts",
      "packages/vps-executor/src/state.ts",
      "packages/vps-executor/test/state.test.ts",
    ];
    const result = runAdmission(legitimate);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /intact/);
  });

  it("admits exactly the sandbox image and runtime files named by path, and the sandbox workflow", () => {
    assert.deepEqual(
      refused([
        ".github/workflows/sandbox-images.yml",
        "packages/sandbox-images/Dockerfile.vps",
        "packages/sandbox-images/README.md",
        "packages/sandbox-images/targets.json",
        "packages/sandbox-images/install/filesystem.sh",
        "packages/sandbox-images/vps/entrypoint.sh",
        "packages/sandbox-images/src/sandbox_images/bundle.py",
        "packages/sandbox-images/src/sandbox_images/native.py",
        "packages/sandbox-images/tests/test_bundle.py",
        "packages/sandbox-images/tests/test_verification.py",
        "packages/sandbox-images/tests/test_vps_seed.py",
        "packages/sandbox-images/verify/smoke_test.py",
        "packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py",
        "packages/sandbox-runtime/src/sandbox_runtime/session_context_start.py",
        "packages/sandbox-runtime/tests/test_session_context_start.py",
      ]),
      []
    );
  });

  it("refuses the neighbours of the sandbox image and runtime files, and the root notes", () => {
    // The root notes live in ignored bookkeeping. A copy at the root is refused, not admitted.
    const neighbours = [
      "packages/sandbox-images/Dockerfile",
      "packages/sandbox-images/Dockerfile.vps.orig",
      "packages/sandbox-images/vps/entrypoint.sh.bak",
      "packages/sandbox-images/vps/entrypoint.py",
      "packages/sandbox-images/install/common.sh",
      "packages/sandbox-images/tests/test_vps_seed.py.bak",
      "packages/sandbox-images/tests/test_vps.py",
      "packages/sandbox-images/src/sandbox_images/bundle.py.orig",
      "packages/sandbox-images/src/sandbox_images/vps.py",
      "packages/sandbox-images/verify/smoke_test.py.bak",
      "packages/sandbox-runtime/src/sandbox_runtime/session_context.py",
      "packages/sandbox-runtime/src/sandbox_runtime/session_context_start.py.orig",
      "packages/sandbox-runtime/src/sandbox_runtime/bin/oi-git-sign",
      "packages/sandbox-runtime/src/sandbox_runtime/gh-wrapper.sh",
      "packages/sandbox-runtime/tests/test_session_context_start.py.bak",
      ".github/workflows/sandbox-images.yml.bak",
      ".github/workflows/sandbox-images.yaml",
      "x/.github/workflows/sandbox-images.yml",
      "VPS-IMAGE-LINUX-BUILD.md",
      "DEPLOY-SHELL-DIAG.md",
      "DEPLOY-SCOPE-FINAL.md",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("admits exactly the team secrets store test and the modal launch, recovery and docker launch files, each by its full path", () => {
    // Exact paths, no directory prefix: a file beside them is refused until it is listed too.
    assert.deepEqual(
      refused([
        "packages/control-plane/test/integration/team-secrets-store.test.ts",
        "packages/modal-infra/src/sandbox/launch_policy.py",
        "packages/modal-infra/src/sandbox/vm_recovery.py",
        "packages/modal-infra/tests/test_docker_launch.py",
      ]),
      []
    );
  });

  it("refuses the neighbours of the team secrets store test and the modal launch, recovery and docker launch files", () => {
    const neighbours = [
      "packages/control-plane/test/integration/team-secrets-store.test.ts.orig",
      "packages/control-plane/test/integration/team-secrets-store.test.tsx",
      "packages/control-plane/test/integration/team-secrets-store.ts",
      "packages/control-plane/test/integration/team-secrets-store.spec.ts",
      "packages/control-plane/test/integration/Team-Secrets-Store.test.ts",
      "packages/control-plane/test/team-secrets-store.test.ts",
      "packages/modal-infra/src/sandbox/launch_policy.py.orig",
      "packages/modal-infra/src/sandbox/launch_policy_helpers.py",
      "packages/modal-infra/src/sandbox/vm_recovery.py.bak",
      "packages/modal-infra/src/sandbox/vm_recovery.pyi",
      "packages/modal-infra/src/sandbox/Vm_Recovery.py",
      "packages/modal-infra/src/vm_recovery.py",
      "packages/modal-infra/tests/test_docker_launch.py.bak",
      "packages/modal-infra/tests/test_docker_launch_extra.py",
      "packages/modal-infra/tests/test_docker.py",
      "x/packages/modal-infra/tests/test_docker_launch.py",
    ];
    assert.deepEqual(refused(neighbours), neighbours);
  });

  it("refuses credential paths beside the team secrets store test and the modal launch and recovery files", () => {
    const credentials = [
      "packages/control-plane/test/integration/team-secrets-store.test.ts.pem",
      "packages/control-plane/test/integration/.env.team",
      "packages/modal-infra/src/sandbox/launch_policy.py.tfstate",
      "packages/modal-infra/src/sandbox/vm_recovery.env",
      "packages/modal-infra/tests/secrets/test_docker_launch.py",
    ];
    const result = runAdmission(credentials);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /credential paths differ from the upstream pin/);
    assert.deepEqual(refused(credentials), credentials);
  });
});

describe("operational files stay LF in every checkout", () => {
  it("pins.env has no carriage return, and .gitattributes pins the deploy files and the workflow to LF", () => {
    // A CRLF pins.env fails the gates and lib.sh's load_release_file, so this names the cause directly.
    assert.doesNotMatch(readFileSync(`${DEPLOY_DIR}/pins.env`, "utf8"), /\r/);
    const attributes = execFileSync(
      "git",
      [
        "check-attr",
        "eol",
        "--",
        "deploy/polytronx/pins.env",
        "deploy/polytronx/lib.sh",
        ".github/workflows/polytronx-openinspect.yml",
      ],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    assert.equal(
      attributes,
      [
        "deploy/polytronx/pins.env: eol: lf",
        "deploy/polytronx/lib.sh: eol: lf",
        ".github/workflows/polytronx-openinspect.yml: eol: lf",
        "",
      ].join("\n")
    );
  });

  it("pins every image shell script and the extensionless oi-git-sign to LF, each by exact path", () => {
    // Every tracked .sh under packages/sandbox-images is in the list, so a new script is refused until it is.
    const shell = execFileSync("git", ["ls-files", "--", "packages/sandbox-images"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => path.endsWith(".sh"));
    const paths = [...shell, "packages/sandbox-runtime/src/sandbox_runtime/bin/oi-git-sign"];
    const attributes = execFileSync("git", ["check-attr", "eol", "--", ...paths], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(attributes, paths.map((path) => `${path}: eol: lf`).join("\n") + "\n");
  });
});

describe("release job gating in the workflow", () => {
  it("the images job needs every other job, so a failed check cannot still produce the artifact", () => {
    const workflow = readFileSync(
      `${REPO_ROOT}/.github/workflows/polytronx-openinspect.yml`,
      "utf8"
    );
    const jobs = workflow.slice(workflow.indexOf("\njobs:"));
    const jobNames = [...jobs.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((match) => match[1]);
    const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(jobs.slice(jobs.indexOf("\n  images:")))[1];
    assert.deepEqual(
      needs
        .split(",")
        .map((name) => name.trim())
        .sort(),
      jobNames.filter((name) => name !== "images").sort()
    );
  });
});

describe("web image build in the release workflow", () => {
  const step = workflowStep("Build the web image");

  it("passes NEXT_PUBLIC_SANDBOX_PROVIDER=vps explicitly, once, so the Dockerfile's modal default is never used", () => {
    assert.match(step, /^ +--build-arg NEXT_PUBLIC_SANDBOX_PROVIDER=vps \\$/m);
    assert.equal((step.match(/NEXT_PUBLIC_SANDBOX_PROVIDER=/g) ?? []).length, 1);
  });

  it("takes NEXT_PUBLIC_WS_URL from pins.env, which names the wss control-plane host", () => {
    assert.match(step, /^ +--build-arg NEXT_PUBLIC_WS_URL="\$PUBLIC_WS_URL" \\$/m);
    assert.match(
      readFileSync(`${DEPLOY_DIR}/pins.env`, "utf8"),
      /^PUBLIC_WS_URL=wss:\/\/cp\.ai\.polytronx\.com$/m
    );
  });
});

describe("pinned third-party images", () => {
  const pins = readFileSync(`${DEPLOY_DIR}/pins.env`, "utf8");
  const compose = readFileSync(`${DEPLOY_DIR}/compose.production.yml`, "utf8");
  // Literal image references in the compose file. A ${...} reference is the release's own image.
  const composeImages = [...compose.matchAll(/^\s+image: (?!\$\{)(\S+)$/gm)].map(
    (match) => match[1]
  );
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
    runSnippet(
      present,
      `source "${present.deploy}/lib.sh"; load_release_file "${present.deploy}/pins.env"; pull_third_party_images`
    );
    assert.equal(
      stubCalls(present).some((line) => line.startsWith("docker pull ")),
      false
    );
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
    const unpinned = pins.replace(
      /^LITESTREAM_IMAGE=.*$/m,
      "LITESTREAM_IMAGE=litestream/litestream:0.3.13"
    );
    writeFileSync(`${sb.deploy}/pins.env`, unpinned);
    assert.equal(thirdPartyProblem(sb), "LITESTREAM_IMAGE in pins.env is not pinned by digest");
  });
});

describe("executor edge CA: the control plane mount and preflight", () => {
  const compose = readFileSync(`${DEPLOY_DIR}/compose.production.yml`, "utf8");
  const app = compose.slice(compose.indexOf("\n  app:"), compose.indexOf("\n  object-store:"));
  const FIXTURE = readFileSync(`${DEPLOY_DIR}/testdata/executor-edge-ca.crt`, "utf8");
  const HAS_OPENSSL =
    spawnSync(BASH, ["-c", "command -v openssl"], { encoding: "utf8" }).status === 0;
  // Joined at run time, so no private-key header is written out in this source.
  const KEY_BEGIN = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const KEY_END = ["-----END", "PRIVATE", "KEY-----"].join(" ");

  /** The CA line the real preflight.sh prints for POLYTRONX_EXECUTOR_CA_FILE; undefined leaves it unset. */
  function caCheck(sb, value, env = {}) {
    const overrides = value === undefined ? {} : { POLYTRONX_EXECUTOR_CA_FILE: value };
    const release = writeRelease(sb, "release.env", overrides);
    const result = runScript(
      sb,
      "preflight.sh",
      ["--release", release, "--secrets-dir", sb.secrets, "--source", sb.root],
      env
    );
    return (
      result.stdout
        .split("\n")
        .find((line) =>
          /^(PASS|FAIL)\s+(executor edge CA|POLYTRONX_EXECUTOR_CA_FILE)/.test(line)
        ) ?? ""
    );
  }

  /** A file at `mode` holding `text`. The Windows stat shim answers the same mode, since NTFS keeps no POSIX modes. */
  function caFile(sb, mode, text = FIXTURE, name = "executor-edge-ca.crt") {
    const path = `${sb.root}/${name}`;
    writeFileSync(path, text);
    chmodSync(path, parseInt(mode, 8));
    return { path, env: { STUB_STAT_MODE: mode } };
  }

  it("mounts the public CA read-only, in long syntax, and names the same path for NODE_EXTRA_CA_CERTS", () => {
    assert.match(
      app,
      /^ {6}- type: bind\n {8}source: \$\{POLYTRONX_EXECUTOR_CA_FILE:\?[^\n]+\}\n {8}target: \/etc\/polytronx\/executor-ca\/ca\.crt\n {8}read_only: true\n {8}bind:\n {10}create_host_path: false$/m
    );
    assert.doesNotMatch(
      app,
      /executor-ca\/ca\.crt:ro/,
      "the short form cannot set create_host_path"
    );
    assert.match(app, /NODE_EXTRA_CA_CERTS: \/etc\/polytronx\/executor-ca\/ca\.crt$/m);
  });

  it("refuses an unset CA path", () => {
    assert.match(
      caCheck(makeSandbox()),
      /^FAIL\s+POLYTRONX_EXECUTOR_CA_FILE is unset or a placeholder/
    );
  });

  it("refuses a missing CA file, and creates nothing at its path", () => {
    const sb = makeSandbox();
    assert.match(
      caCheck(sb, `${sb.root}/absent/executor-edge-ca.crt`),
      /^FAIL\s+POLYTRONX_EXECUTOR_CA_FILE does not exist/
    );
    assert.equal(
      existsSync(`${sb.root}/absent`),
      false,
      "preflight must not create the mount source"
    );
  });

  it("refuses a directory and a file that is not a PEM certificate", () => {
    const sb = makeSandbox();
    mkdirSync(`${sb.root}/ca-dir`);
    assert.match(
      caCheck(sb, `${sb.root}/ca-dir`),
      /^FAIL\s+POLYTRONX_EXECUTOR_CA_FILE must be a readable regular file/
    );
    const notCert = caFile(sb, "644", "sanitized placeholder\n", "not-a-cert.crt");
    assert.match(
      caCheck(sb, notCert.path, notCert.env),
      /^FAIL\s+POLYTRONX_EXECUTOR_CA_FILE is not a PEM certificate/
    );
  });

  it("refuses a CA file that holds private-key bytes, even beside the certificate", () => {
    const sb = makeSandbox();
    const keyed = caFile(
      sb,
      "644",
      `${FIXTURE}${KEY_BEGIN}\nsanitized placeholder, not a key\n${KEY_END}\n`
    );
    assert.match(
      caCheck(sb, keyed.path, keyed.env),
      /^FAIL\s+POLYTRONX_EXECUTOR_CA_FILE holds private-key bytes/
    );
  });

  it("refuses a CA file the container user cannot read: a root-only 0600 file passes root's read test, so the mode is what refuses it", () => {
    for (const mode of ["600", "640"]) {
      const sb = makeSandbox();
      const { path, env } = caFile(sb, mode);
      assert.match(
        caCheck(sb, path, env),
        new RegExp(
          `^FAIL\\s+POLYTRONX_EXECUTOR_CA_FILE is mode ${mode}; the control plane reads it as uid 1000`
        ),
        mode
      );
    }
  });

  it(
    "follows a symlink to the CA file, so a link to a 0600 file is refused by the target's mode",
    {
      skip:
        process.platform === "win32" &&
        "creating a symlink needs privileges on Windows; the Linux runner checks this",
    },
    () => {
      const sb = makeSandbox();
      const target = `${sb.root}/target-ca.crt`;
      writeFileSync(target, FIXTURE);
      chmodSync(target, 0o600);
      const link = `${sb.root}/linked-ca.crt`;
      symlinkSync(target, link);
      assert.match(caCheck(sb, link), /^FAIL\s+POLYTRONX_EXECUTOR_CA_FILE is mode 600/);
    }
  );

  it(
    "accepts the public CA certificate at mode 0644",
    { skip: !HAS_OPENSSL && "openssl is not installed" },
    () => {
      const sb = makeSandbox();
      const { path, env } = caFile(sb, "644");
      assert.match(
        caCheck(sb, path, env),
        /^PASS\s+executor edge CA is world-readable, holds a certificate and no private key/
      );
    }
  );

  it("checks that openssl is installed before it reads the CA, so a host without it gets the tool error", () => {
    const preflight = readFileSync(`${DEPLOY_DIR}/preflight.sh`, "utf8");
    const toolError = preflight.indexOf(
      'fail "openssl is required to verify POLYTRONX_EXECUTOR_CA_FILE"'
    );
    assert.ok(toolError > 0, "preflight.sh must name the missing tool");
    assert.ok(
      toolError < preflight.indexOf('openssl x509 -in "$ca_file"'),
      "the tool check must come before the CA is parsed"
    );
  });

  it("names the public CA under trust/, outside the secrets directory, in the release template", () => {
    const template = readFileSync(`${DEPLOY_DIR}/templates/release.env.template`, "utf8").replace(
      /\r\n/g,
      "\n"
    );
    assert.match(
      template,
      /^POLYTRONX_EXECUTOR_CA_FILE=\/opt\/polytronx\/openinspect\/trust\/executor-edge-ca\.crt$/m
    );
  });
});

describe("executor config and the 0090 migration", () => {
  const compose = readFileSync(`${DEPLOY_DIR}/compose.executor.yml`, "utf8");
  const executorSource = readFileSync(`${REPO_ROOT}/packages/vps-executor/src/index.ts`, "utf8");
  const BASE_ENV = {
    VPS_EXECUTOR_TOKEN: "x".repeat(32),
    VPS_EXECUTOR_ADMISSION_SECRET: "y".repeat(32),
    VPS_EXECUTOR_IMAGE: "open-inspect/sandbox:1",
  };

  it("has readConfig refuse a missing or non-https control-plane URL, and trim a trailing slash", async () => {
    // The real function, loaded from source. index.ts imports only Node built-ins and its own files, so nothing is installed.
    const { readConfig } = await import(
      pathToFileURL(`${REPO_ROOT}/packages/vps-executor/src/index.ts`).href
    );
    assert.throws(
      () => readConfig(BASE_ENV),
      /VPS_EXECUTOR_CONTROL_PLANE_URL must be an absolute https URL/
    );
    assert.throws(
      () => readConfig({ ...BASE_ENV, VPS_EXECUTOR_CONTROL_PLANE_URL: "http://cp.example.test" }),
      /VPS_EXECUTOR_CONTROL_PLANE_URL must be an absolute https URL/
    );
    const config = readConfig({
      ...BASE_ENV,
      VPS_EXECUTOR_CONTROL_PLANE_URL: "https://cp.example.test/",
    });
    assert.equal(config.controlPlaneUrl, "https://cp.example.test");
  });

  it("names only settings that readConfig reads, and sets the control-plane URL, so compose and code cannot drift apart", () => {
    const names = [
      ...new Set([...compose.matchAll(/^\s+(VPS_EXECUTOR_[A-Z_]+):/gm)].map((match) => match[1])),
    ];
    assert.ok(
      names.includes("VPS_EXECUTOR_CONTROL_PLANE_URL"),
      "compose must set the control-plane URL"
    );
    for (const name of names)
      assert.ok(executorSource.includes(`env.${name}`), `readConfig must read ${name}`);
  });

  it("makes 0090 the migration head, and the column it adds the one the control plane writes", () => {
    const migrations = `${REPO_ROOT}/terraform/d1/migrations`;
    const head = readdirSync(migrations)
      .filter((name) => /^\d{4}_/.test(name))
      .sort()
      .at(-1);
    assert.equal(head, "0090_sandbox_admission_relinquished.sql");
    assert.match(
      readFileSync(`${migrations}/${head}`, "utf8"),
      /ALTER TABLE sandbox_admission_reservations ADD COLUMN relinquished_at INTEGER;/
    );
    assert.match(
      readFileSync(
        `${REPO_ROOT}/packages/control-plane/src/sandbox/admission/reservations.ts`,
        "utf8"
      ),
      /relinquished_at/
    );
  });
});

describe("runbook references resolve", () => {
  // The deploy files an operator or a script follows: markdown, shell, compose, JS, templates and units.
  const FILES = readdirSync(DEPLOY_DIR, { recursive: true })
    .map(String)
    .filter((file) => /\.(md|sh|mjs|yml|template|service|timer)$/.test(file))
    .map((file) => join(DEPLOY_DIR, file));

  it("every relative markdown link in the deploy files points at a file in the tree", () => {
    const broken = [];
    for (const file of FILES.filter((path) => path.endsWith(".md"))) {
      for (const [, target] of readFileSync(file, "utf8").matchAll(
        /\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g
      )) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        if (!existsSync(join(dirname(file), target))) broken.push(`${file}: ${target}`);
      }
    }
    assert.deepEqual(broken, []);
  });

  it("every runbooks/<name>.md that a deploy file names exists, so no operator is sent to a missing page", () => {
    const missing = [];
    for (const file of FILES) {
      for (const [, name] of readFileSync(file, "utf8").matchAll(
        /runbooks\/([A-Za-z0-9-]+\.md)/g
      )) {
        if (!existsSync(join(DEPLOY_DIR, "runbooks", name)))
          missing.push(`${file}: runbooks/${name}`);
      }
    }
    assert.deepEqual(missing, []);
  });
});
