# Secure SSH deployment

How the two production hosts are reached from GitHub Actions, how the keys are made, how they are
verified, and how the executor host is replaced without touching the dashboard.

| Host                                  | Role                                  | Replaced                | Environment            |
| ------------------------------------- | ------------------------------------- | ----------------------- | ---------------------- |
| Dashboard VPS (185.252.233.186)       | Control plane, web, database, edge    | Never                   | `dashboard-production` |
| Executor VPS (Linode, 172.235.26.148) | Sandboxes, executor, gVisor workloads | Every one or two months | `executor-production`  |

The two environments are separate on purpose. Each holds its own private key, and a key for one host
never authenticates to the other. The dashboard key stays the same when the Linode is replaced.

Nothing in this runbook has been run against a host yet. What has and has not run is in
[evidence-register.md](evidence-register.md).

## What the repository provides

| Asset                                                   | Role                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `.github/actions/ssh-setup/action.yml`                  | Writes the key and the known hosts file, checks the host key against the recorded fingerprint. |
| `.github/workflows/ssh-deploy-dashboard.yml`            | Deploys the dashboard from the `dashboard-production` environment, by hand only.               |
| `.github/workflows/ssh-deploy-executor.yml`             | Deploys the executor from the `executor-production` environment, by hand only.                 |
| `deploy/polytronx/host-dashboard-deploy.sh`             | The dashboard deployment, run on the host.                                                     |
| `deploy/polytronx/host-executor-deploy.sh`              | The executor deployment, run on the host.                                                      |
| `scripts/ship-dashboard.sh`, `scripts/ship-executor.sh` | The same deployments, started from the operator's machine instead of from Actions.             |
| `scripts/ssh-verify.mjs`                                | Checks a host's identity and the key's authentication before Actions may use them.             |
| `scripts/ssh-deploy-contract.test.mjs`                  | Guards the workflows and the action: manual runs, separate environments, verified host keys.   |

The deployment itself is unchanged: the same `deploy.sh`, `preflight.sh`, `backup.sh` and `smoke.sh`
run, in the same order, whichever way the run starts. Only the way the runner reaches the host is
new.

## 1. The keys

Two dedicated keys, one per host. They are not the operator's personal key, and they are not the
provider's root key.

On Windows, in PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.ssh" | Out-Null
ssh-keygen -t ed25519 -a 100 -f "$HOME\.ssh\bg_dashboard_ci" -C "backgroundagents-dashboard-actions"
ssh-keygen -t ed25519 -a 100 -f "$HOME\.ssh\bg_executor_ci" -C "backgroundagents-executor-actions"
```

On Linux:

```bash
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/bg_dashboard_ci -C "backgroundagents-dashboard-actions"
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/bg_executor_ci -C "backgroundagents-executor-actions"
```

Leave the passphrase empty for these two keys: they are unattended deployment keys, and the
passphrase would have to live in the environment secret next to the key, which buys nothing. Keep
passphrases on the personal keys.

The four files are `bg_dashboard_ci`, `bg_dashboard_ci.pub`, `bg_executor_ci` and
`bg_executor_ci.pub`. The two private keys never leave the operator's machine except as an encrypted
GitHub environment secret. They are never committed, never pasted into a chat, and never written
into a deployment file.

## 2. The deployment account on each host

Each host gets one account that the deployment key logs in as. It is not a human login.

```bash
id deploy >/dev/null 2>&1 || sudo adduser --disabled-password --gecos "" deploy
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo touch /home/deploy/.ssh/authorized_keys
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
sudo nano /home/deploy/.ssh/authorized_keys
```

Paste `bg_dashboard_ci.pub` on the dashboard host and `bg_executor_ci.pub` on the executor host.
Never the other way round.

The account needs no password, no shell for humans and no group membership. It needs exactly one
privilege: running the host's deployment entry point as root, through one sudoers rule (section 6).
It does not need the `docker` group: access to the Docker socket is root-equivalent, and the
deployment runs as root through that one rule instead.

The staging directory the account writes to lives in its own home, `~/.polytronx`, so nothing
outside the account's home is writable by it.

## 3. The host keys, verified twice

`ssh-keyscan` does not authenticate a server. It only says what the server says. The fingerprint has
to come from the server itself.

On each host, from the provider's console:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Write the fingerprint down. It is the `SHA256:...` value, and it is public.

On the operator's machine, build the known hosts file and check it against the value from the
console:

```powershell
ssh-keyscan -p 22 -t ed25519 "DASHBOARD_IP" | Out-File -Encoding ascii "$HOME\.ssh\bg_dashboard_known_hosts"
ssh-keyscan -p 22 -t ed25519 "LINODE_IP" | Out-File -Encoding ascii "$HOME\.ssh\bg_executor_known_hosts"
ssh-keygen -lf "$HOME\.ssh\bg_dashboard_known_hosts" -E sha256
ssh-keygen -lf "$HOME\.ssh\bg_executor_known_hosts" -E sha256
```

Both must print the fingerprint the console printed. Then run the repository's own check, which does
the same comparison and also authenticates with the key:

```bash
node scripts/ssh-verify.mjs --host DASHBOARD_IP --user deploy --port 22 \
  --key ~/.ssh/bg_dashboard_ci --known-hosts ~/.ssh/bg_dashboard_known_hosts \
  --fingerprint "SHA256:the value the console printed"
```

The tool prints one PASS or FAIL line per check and exits non-zero when a check fails. It never
prints the key. A FAIL means the host identity is not the one that was verified, and the deployment
stops there.

## 4. The two GitHub environments

In the repository settings, create two environments. Each holds its own secret and its own
variables, and each is protected on its own terms.

**`dashboard-production`**

| Kind     | Name                   | Value                                                   |
| -------- | ---------------------- | ------------------------------------------------------- |
| Secret   | `SSH_PRIVATE_KEY`      | The whole contents of `~/.ssh/bg_dashboard_ci`          |
| Variable | `SSH_HOST`             | The dashboard VPS address or name                       |
| Variable | `SSH_USER`             | `deploy`                                                |
| Variable | `SSH_PORT`             | The SSH port, usually `22`                              |
| Variable | `SSH_KNOWN_HOSTS`      | The contents of `bg_dashboard_known_hosts`              |
| Variable | `SSH_HOST_FINGERPRINT` | The `SHA256:...` fingerprint from the dashboard console |

**`executor-production`**

| Kind     | Name                   | Value                                                  |
| -------- | ---------------------- | ------------------------------------------------------ |
| Secret   | `SSH_PRIVATE_KEY`      | The whole contents of `~/.ssh/bg_executor_ci`          |
| Variable | `SSH_HOST`             | The current Linode address or name                     |
| Variable | `SSH_USER`             | `deploy`                                               |
| Variable | `SSH_PORT`             | The SSH port, usually `22`                             |
| Variable | `SSH_KNOWN_HOSTS`      | The contents of `bg_executor_known_hosts`              |
| Variable | `SSH_HOST_FINGERPRINT` | The `SHA256:...` fingerprint from the executor console |

The same secret name in two environments is deliberate: each workflow reads the secret of the
environment it runs in, and never the other one.

To copy a key without showing it on screen, put it on the clipboard and paste it into the secret
field:

```powershell
Get-Content "$HOME\.ssh\bg_dashboard_ci" -Raw | Set-Clipboard
Set-Clipboard -Value ""
```

Do the same for the executor key. GitHub encrypts environment secrets at rest and never prints them
again.

## 5. The protection rules

For both environments:

1. **Deployment branches and tags**: allow `main` only. The workflows also refuse a ref that is not
   `refs/heads/main`, so a mistake in the rule is caught by the run.
2. **Required reviewers**: enable it. The deployment waits for the approval.
3. **Deployment branch and tag filters**: keep `main` and nothing else.
4. **Environment secrets**: only `SSH_PRIVATE_KEY`. Nothing else belongs here.
5. **Environment variables**: the six names above. They are not secrets, and they are what the run
   prints when it refuses to start.

The workflows themselves are the least-privilege part: `permissions: contents: read`, no
`pull_request` or `push` trigger, and no third-party action. The key is written into the runner's
temporary directory with mode 0600 and removed when the job ends.

The runner reaches the hosts over the public internet. If the firewall admits only fixed addresses,
use a self-hosted runner inside that network instead of weakening the SSH settings.

## 6. The host entry point

The deployment needs root on the host: it writes the state directory, drives Docker, mounts the
workspace slots and applies the executor's firewall rules. The account gets that root through one
rule and nothing else.

Install the entry point on the dashboard host, from a checkout of this repository:

```bash
sudo install -m 0755 -o root -g root deploy/polytronx/host-dashboard-deploy.sh /usr/local/sbin/polytronx-dashboard-deploy
```

On the executor host:

```bash
sudo install -m 0755 -o root -g root deploy/polytronx/host-executor-deploy.sh /usr/local/sbin/polytronx-executor-deploy
```

Then give the account one rule, in `/etc/sudoers.d/polytronx-deploy`:

```
deploy ALL=(root) NOPASSWD: /usr/local/sbin/polytronx-dashboard-deploy --staged * --root /opt/polytronx/openinspect --revision *
```

and on the executor host:

```
deploy ALL=(root) NOPASSWD: /usr/local/sbin/polytronx-executor-deploy --staged * --root /opt/polytronx/executor --revision *
```

Check the file before saving it, and again after:

```bash
sudo visudo -c
```

The rule names the command and the arguments, so the account cannot run anything else as root, and
it cannot read a secret or write to the deployment directories.

What this model does not protect against: the account is trusted with the code it deploys. The entry
point installs the staged tree and runs it as root, so anything the account stages runs as root. The
trust is anchored in the key, which lives only in the protected environment secret, and in the code,
which is only deployed from `main` after review.

The operator's own path (`scripts/ship-dashboard.sh`, `scripts/ship-executor.sh`) runs the same host
scripts, so there is one deployment and one set of checks.

## 7. Running a deployment

Both workflows are manual. In the Actions tab, run **Deploy the dashboard over SSH** or **Deploy the
executor over SSH**.

Without the `deploy` input, the run stops after the read-only preflight: the tree is staged and
checked on the host, and nothing that runs the project changes. Read the preflight lines, resolve
every FAIL and every WARN, and only then run it again with `deploy` set.

With `deploy` set, the host does the work in a fixed order:

```
staged tree → preflight → backup → up → smoke → health check
```

The dashboard host:

1. Installs the staged tree as `/opt/polytronx/openinspect/source`, keeping the previous one as
   `source.bak-<timestamp>`.
2. Replays the free models the two-hourly sync added on the host, so a release from the repository
   keeps them.
3. Pulls the pinned third-party images that are missing, and builds the control-plane and web images
   from the tree, tagged with the revision.
4. Records the new images and their IDs in `state/release.env`.
5. Runs `preflight.sh`. Any FAIL stops here and puts the previous release file back.
6. Runs `deploy.sh`: the project lock, an encrypted backup of the persistent state, the edge
   network, `up --wait --pull never`, and `smoke.sh`.
7. Records the result in `state/deploy-log.txt`.

The executor host does the same for the executor: the workspace slots are checked, the executor
image is built from the staged package, `preflight-executor.sh` runs, and `deploy-executor.sh`
brings the project up and waits for the health check that answers only when gVisor is registered.

`rollback_on_failure` makes the run roll back to the last release that passed, when the deployment
fails. Without it, the run prints the way back and stops. `state/last-good.env` is the rollback
target on both hosts.

The deployment is a manual production change. Review the diff of the commit the run deploys before
it starts, and watch the run.

## 8. Replacing the executor host

The executor host is replaced every one or two months. Its credentials are replaced with it, and the
dashboard's key is not touched.

1. Drain the workloads: stop the sessions through the control plane, and let the sandboxes stop. The
   retained workspaces are released by the three-day timer, or by the janitor.
2. Generate a new key pair for the new host:
   ```bash
   ssh-keygen -t ed25519 -a 100 -f ~/.ssh/bg_executor_ci -C "backgroundagents-executor-actions"
   ```
3. Install the new public key on the new host, as the `deploy` account's `authorized_keys` entry,
   and install the entry point and the sudoers rule from section 6.
4. Read the new host's fingerprint from its console and check the known hosts file against it, as in
   section 3.
5. Replace the `executor-production` environment's secret and variables: the new `SSH_PRIVATE_KEY`,
   the new `SSH_HOST`, the new `SSH_KNOWN_HOSTS` and the new `SSH_HOST_FINGERPRINT`.
6. Run the executor workflow with `deploy` set. It stops after the preflight first, so run it that
   way once.
7. Update the dashboard host's executor settings: the control-plane URL in
   `secrets/control-plane.env`, and the executor's public CA certificate at
   `/opt/polytronx/openinspect/trust/executor-edge-ca.crt` (the `ca.crt` only, never `ca.key`, mode
   0644). The private edge in `runbooks/private-edge.md` admits the dashboard address only; a new
   executor address needs the new edge's own certificate.
8. Revoke the old host's key when the new one is healthy: remove its `authorized_keys` entry, and
   delete the old host.

Until step 7 is done, the dashboard host still points at the old executor and its sessions fail. Do
the steps in order.

## What has not run yet

Nothing in this runbook has been executed against either host. The workflows have never been
dispatched, no environment exists yet, and no key has been installed. The steps above are written to
be followed in order, and the first run should be a preflight run without the `deploy` input.
