# GitHub deployment access: two independent VPS hosts

This runbook covers **readiness only**. It does not install keys, start a
sandbox, deploy an image, alter production configuration, or grant ChatGPT an
interactive SSH session.

| Environment | Host | Rotation policy |
| --- | --- | --- |
| `dashboard-production` | Permanent dashboard/control-plane VPS | Preserve its SSH key when executors are replaced. |
| `executor-production` | Replaceable Linode Linux executor | Replace the SSH key and host entry whenever the worker is replaced. |

## Operator setup on Windows

1. Preserve any existing personal keys. Generate two separate, dedicated
   Ed25519 automation key pairs; never commit or paste private keys in chat.
2. Place each **public** key in the matching host's non-root `deploy`
   account `~/.ssh/authorized_keys`. Do not share keys between hosts.
3. Verify each SSH host fingerprint through the provider console (not
   `ssh-keyscan` alone) and record its known-hosts line.
4. In repository **Settings → Environments**, create the two environments
   above. Under each one store its own `SSH_PRIVATE_KEY` environment
   **secret**, plus `SSH_HOST`, `SSH_USER`, `SSH_PORT`, and
   `SSH_KNOWN_HOSTS` environment **variables**.
5. Protect both environments with allowed deployment branches (`main`
   only) and required reviewers where the repository plan permits. Limit
   the `deploy` accounts to approved commands. Docker socket access and
   unrestricted sudo are root-equivalent and must not be granted casually.
6. Keep the key backups in a secure credential vault. Do not store private
   keys in repository paths, workflow inputs, build artifacts, or logs.

The GitHub workflows use those variables only at runtime. An environment
secret is not retrievable by this chat or the GitHub connector.

## Before deploying

After the role, VPS capacity, and rotation PRs pass their required checks
and the reviewed SSH-readiness changes reach `main`, manually run the
following under the **Actions** tab:

- `Dashboard SSH readiness` for the permanent control-plane host.
- `Executor SSH readiness` for the current Linode host.

Both workflows are **manual-only** (`workflow_dispatch`), require
`main`, and use their respective protected environments. The probe:

- Validates required settings, SSH port, hostname and non-root username.
- Writes the private key to a mode-0600 runner-only temporary file,
  verifies it can be used without a passphrase, and removes it on exit.
- Requires the independently verified host/port entry in
  `SSH_KNOWN_HOSTS`. It never silently accepts a different host key.
- Connects with public-key authentication, no agent forwarding, no port
  forwarding, no user SSH configuration, and no password fallback.
- Executes only read-only Linux and non-root identity checks on the
  remote host.

**A successful probe proves only non-root SSH connectivity and host-key
validation.** It does not prove deploy privileges, backups, working
Docker/gVisor, dashboard health, or network isolation.

## Executor replacement

For a new Linode, generate a **new executor automation key** and install
only its public half on the new host. Verify the new SSH host fingerprint,
then replace `executor-production` secret and variable values. Run the
executor readiness check. Do not alter the dashboard SSH environment.

Continue the full [executor host](executor-host.md) and
[private edge](private-edge.md) preflights; retain and drain old jobs,
workspaces, tokens and CA trust according to the
[deployment runbook](deploy-and-rollback.md). Old executors must not be
deleted until the new one passes acceptance and any needed workspace
transfer is verified.

## Remaining production gates

The two SSH readiness workflows are **not** automated deployment jobs.
To authorize any actual deployment, first verify the release build artifact
and revision, control-plane encrypted backup and rollback path, executor
Docker/gVisor/capacity/network gates, and the manually approved cutover.
Keep production deployment disabled until a separately reviewed deploy
workflow and operator approval are available.
