// Guards for the two SSH deployment workflows and the SSH setup action they share. The
// rules are the ones a production deployment may not break: manual runs only, the
// environment that holds the key, the least token permissions, a verified host key, and
// a key that is never printed.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const dashboard = await read("../.github/workflows/ssh-deploy-dashboard.yml");
const executor = await read("../.github/workflows/ssh-deploy-executor.yml");
const action = await read("../.github/actions/ssh-setup/action.yml");

const workflows = [
  {
    name: "dashboard",
    text: dashboard,
    environment: "dashboard-production",
    entryPoint: "polytronx-dashboard-deploy",
  },
  {
    name: "executor",
    text: executor,
    environment: "executor-production",
    entryPoint: "polytronx-executor-deploy",
  },
];

/** The text of a workflow's trigger block. */
function triggersOf(text) {
  const start = text.indexOf("\non:\n");
  assert.notEqual(start, -1, "the workflow has no on: block");
  const rest = text.slice(start + 5);
  const end = rest.search(/\n[a-zA-Z]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every run block of a workflow. */
function runBlocksOf(text) {
  const blocks = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s+run: \|\s*$/.test(lines[index])) continue;
    const body = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim() === "") {
        body.push("");
        continue;
      }
      if (!/^\s{8,}/.test(line)) break;
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

/** The lines of a file that are not comments. */
function withoutComments(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

for (const workflow of workflows) {
  test(`the ${workflow.name} deployment runs only by hand`, () => {
    const triggers = triggersOf(workflow.text);
    assert.match(triggers, /workflow_dispatch/);
    assert.doesNotMatch(triggers, /pull_request|push:|schedule:|repository_dispatch/);
  });

  test(`the ${workflow.name} deployment runs in the ${workflow.environment} environment`, () => {
    assert.match(workflow.text, new RegExp(`environment:\\s*\\n\\s*name: ${workflow.environment}`));
  });

  test(`the ${workflow.name} deployment holds the least token permissions`, () => {
    assert.match(workflow.text, /permissions:\s*\n\s+contents: read/);
    const permissions = workflow.text.slice(workflow.text.indexOf("permissions:"));
    const block = permissions.slice(0, permissions.indexOf("\n\n"));
    assert.doesNotMatch(block, /write|admin/);
  });

  test(`the ${workflow.name} deployment refuses a ref that is not main`, () => {
    assert.match(workflow.text, /refs\/heads\/main/);
    assert.match(workflow.text, /GITHUB_REF/);
  });

  test(`the ${workflow.name} deployment key never reaches a log`, () => {
    for (const block of runBlocksOf(workflow.text)) {
      assert.doesNotMatch(block, /echo\s+"?\$\{?(SSH_)?PRIVATE_KEY\}?"/);
      assert.doesNotMatch(block, /cat\s+"?\$\{?(SSH_)?PRIVATE_KEY\}?"/);
      assert.doesNotMatch(block, /printf[^\n]*"\$\{?(SSH_)?PRIVATE_KEY\}?"/);
      assert.doesNotMatch(block, /set -x/);
    }
    // The key is read from the environment secret and handed to the action, nowhere else.
    assert.match(workflow.text, /secrets\.SSH_PRIVATE_KEY/);
  });

  test(`the ${workflow.name} deployment runs its privileged command without a prompt`, () => {
    assert.match(workflow.text, /sudo -n \/usr\/local\/sbin\//);
    assert.doesNotMatch(workflow.text, /sudo (?![-n])/);
  });

  test(`the ${workflow.name} deployment keeps the host key check on`, () => {
    assert.doesNotMatch(
      workflow.text,
      /StrictHostKeyChecking=no|StrictHostKeyChecking no|accept-new/
    );
    assert.doesNotMatch(workflow.text, /UserKnownHostsFile=\/dev\/null/);
  });

  test(`the ${workflow.name} deployment pins every action it uses`, () => {
    for (const match of workflow.text.matchAll(/^\s*uses:\s*(\S+)/gm)) {
      const reference = match[1];
      if (reference.startsWith("./")) continue;
      assert.match(reference, /@[0-9a-f]{40}$/, `${reference} is not pinned to a commit`);
    }
  });

  test(`the ${workflow.name} deployment names only its own host`, () => {
    const other = workflows.find((candidate) => candidate.name !== workflow.name);
    const body = withoutComments(workflow.text);
    assert.doesNotMatch(body, new RegExp(other.entryPoint));
    assert.doesNotMatch(body, new RegExp(other.environment));
  });
}

test("the SSH setup writes the key with owner-only permissions", () => {
  assert.match(action, /chmod 600 "\$dir\/id_ed25519"/);
});

test("each deployment removes the key when the job ends", () => {
  // The key must live through the whole job, and go before the runner is reused.
  for (const workflow of workflows) {
    assert.match(workflow.text, /rm -f "\$RUNNER_TEMP\/polytronx-ssh\/id_ed25519"/);
  }
  // The action itself must not remove it: that would delete the key before the
  // workflow's first connection.
  assert.doesNotMatch(action, /rm -f "\$RUNNER_TEMP\/polytronx-ssh\/id_ed25519"/);
});

test("each deployment reads the staged path under the name it writes", () => {
  // The runner's environment is case sensitive, so a name that is written in one case
  // and read in another leaves the step with an unbound variable.
  for (const workflow of workflows) {
    assert.match(workflow.text, /echo "STAGED=\$staged" >>"\$GITHUB_ENV"/);
    assert.match(workflow.text, /--staged '\$STAGED'/);
    assert.doesNotMatch(workflow.text, /--staged '\$staged'/);
  }
});

test("the SSH setup keeps the host key check on and the key alone", () => {
  assert.match(action, /StrictHostKeyChecking yes/);
  assert.match(action, /IdentitiesOnly yes/);
  assert.match(action, /BatchMode yes/);
  assert.match(action, /PasswordAuthentication no/);
  assert.match(action, /KbdInteractiveAuthentication no/);
  assert.match(action, /UpdateHostKeys no/);
  assert.doesNotMatch(action, /StrictHostKeyChecking=no|accept-new/);
});

test("the SSH setup checks the host key against the fingerprint from the console", () => {
  assert.match(action, /ssh-keyscan/);
  assert.match(action, /ssh-keygen -l -f - -E sha256/);
  assert.match(action, /grep -qxF "\$expected"/);
  // The fingerprint is required: the run stops when it is missing.
  assert.match(action, /fingerprint:\s*\n\s+description:[^\n]*\n\s+required: true/);
  // A scan this runner cannot complete is a warning, not a mismatch: the connection
  // holds the host to the verified key on its own.
  assert.match(action, /::warning::The host key could not be scanned/);
  assert.match(action, /::error::The host key \$HOST presents does not match/);
});

test("the SSH setup reads the key from the secret and never prints it", () => {
  assert.match(action, /PRIVATE_KEY: \$\{\{ inputs\.private-key \}\}/);
  for (const block of runBlocksOf(action)) {
    assert.doesNotMatch(block, /echo\s+"?\$\{?PRIVATE_KEY\}?"/);
    assert.doesNotMatch(block, /cat\s+"?\$\{?PRIVATE_KEY\}?"/);
  }
  // A key pasted from a Windows editor carries CRLF, which OpenSSH refuses.
  assert.match(action, /tr -d '\\r'/);
});

test("the deployment workflows use the shared SSH setup action", () => {
  for (const workflow of workflows) {
    assert.match(workflow.text, /uses: \.\/\.github\/actions\/ssh-setup/);
    assert.match(workflow.text, /private-key: \$\{\{ secrets\.SSH_PRIVATE_KEY \}\}/);
    assert.match(workflow.text, /known-hosts: \$\{\{ vars\.SSH_KNOWN_HOSTS \}\}/);
    assert.match(workflow.text, /fingerprint: \$\{\{ vars\.SSH_HOST_FINGERPRINT \}\}/);
  }
});
