# Replaceable VPS executor: safe rotation and deployment access

This runbook covers a permanent dashboard/control-plane VPS and a replaceable Linode (or other
Linux) executor VPS. The dashboard, its database, GitHub deployment environment and dashboard
SSH credentials survive executor replacement. Executors and their SSH/TLS material do not.
This is an **operator checklist**, not an automated migration or permission to deploy.

## Trust boundaries

- The dashboard/control-plane VPS is permanent. Keep its deployment access in GitHub environment
  `dashboard-production`. Do not reuse this credential on executor hosts.
- The executor is disposable (often replaced every 1–2 months). Keep its deployment access in
  environment `executor-production`. Rotate the executor key when you replace the server.
- Store each `SSH_PRIVATE_KEY` as an **environment secret**, never as a repository file, workflow
  literal, artifact, chat message or pull-request variable. Configure environment-scoped
  `SSH_HOST`, `SSH_PORT`, `SSH_USER` and independently verified `SSH_KNOWN_HOSTS` values.
  Use separate, minimally privileged `deploy` accounts and constrain their server commands.
  Protect the production environments with a reviewer and branch restrictions where available.
- Keep the executor bearer token and admission secret in the host's `executor.env` and the
  control plane's `control-plane.env`. Do not store them in release manifests or CI artifacts.
- Require host-key checking and TLS certificate verification. Never use
  `StrictHostKeyChecking=no` or `NODE_TLS_REJECT_UNAUTHORIZED=0`.

### Windows machine: keys without committing private material

Open **PowerShell**. Recover existing keys if available:

```powershell
Get-ChildItem "$HOME\.ssh"
```

For newly provisioned `deploy` accounts, generate independent key pairs on the operator's PC
(the prompts ask for passphrases; use passphrases for interactive keys):

```powershell
New-Item -ItemType Directory -Force "$HOME\.ssh" | Out-Null
ssh-keygen -t ed25519 -a 100 -f "$HOME\.ssh\backgroundagents_dashboard" -C "dashboard-deploy"
ssh-keygen -t ed25519 -a 100 -f "$HOME\.ssh\backgroundagents_executor" -C "executor-deploy"
Get-Content "$HOME\.ssh\backgroundagents_dashboard.pub"
Get-Content "$HOME\.ssh\backgroundagents_executor.pub"
```

Install each **public** key only in the corresponding host's `deploy` user's
`~/.ssh/authorized_keys`. If a key was lost during Windows reinstall, use the provider's trusted
console and revoke that key on the host. For an unattended CI key, provision a **separate**
restricted, non-passphrase deployment credential rather than copying the operator's personal key.
Set that CI private key in the matching GitHub environment secret. The public host key must be
checked against the fingerprint obtained through the provider console; `ssh-keyscan` alone does
not authenticate a host.

The current repository builds release archives but does **not** contain a verified production
SSH deploy workflow. Adding secrets to GitHub does not itself deploy anything.

## Edge address and source configuration

The executor HTTPS edge is configured by environment variables read by
`private-executor-edge.sh`. Defaults preserve the existing single-host configuration:

| Name | Meaning | Existing default |
| --- | --- | --- |
| `POLYTRONX_EXECUTOR_EDGE_ADDRESS` | IPv4 **owned by the new executor** | `172.235.26.148` |
| `POLYTRONX_DASHBOARD_SOURCE_IPV4` | IPv4 of the **permanent dashboard** allowed through | `185.252.233.186` |

An operator may set both to the actual public or routed private **unicast IPv4** addresses.
Hostnames, CIDRs, wildcard/broadcast, loopback, multicast, link-local, malformed octets and
shell metacharacters are refused. A custom executor address must actually be assigned to its host,
or the `apply` command refuses it. Port `19443` and upstream `127.0.0.1:8787` remain fixed.
The edge CA and server certificate are generated **on the new executor**. They must match its new
address; mismatched existing certificates are refused rather than silently overwritten.

Example with placeholder addresses (replace with assigned, verified values):

```bash
# On the *new executor host*, not the dashboard host; run render first.
sudo env POLYTRONX_EXECUTOR_EDGE_ADDRESS=198.51.100.42 \
  POLYTRONX_DASHBOARD_SOURCE_IPV4=203.0.113.15 \
  bash deploy/polytronx/private-executor-edge.sh render

# Only after verifying firewall/SSH access, Docker, gVisor and sandbox network:
sudo env POLYTRONX_EXECUTOR_EDGE_ADDRESS=198.51.100.42 \
  POLYTRONX_DASHBOARD_SOURCE_IPV4=203.0.113.15 \
  bash deploy/polytronx/private-executor-edge.sh apply --caddy-archive /root/VERIFIED-caddy-archive.tar.gz
```

The example IPs above are documentation-only and must not be used as real addresses. Use the
**same configured endpoints on `render`, `apply`, `check`, and `rollback`**. Changing
`POLYTRONX_DASHBOARD_SOURCE_IPV4` on a reused host requires a reviewed UFW policy migration;
the script intentionally does not remove a previously authorized source automatically.

## Safe rotation sequence (without redeploying the dashboard)

1. **Before replacing the old executor:** Block new admissions and let active jobs complete.
   Record running sandboxes, uncommitted Git work and retained workspaces. A saved sandbox
   workspace does **not** automatically migrate to the new host; preserve required output in
   Git, external storage or a separately verified backup. Do not destroy old state yet.
2. **Provision new Linode:** Install and verify Docker Engine, gVisor (`runsc`), sandbox image
   by digest, and host firewall. Configure `workspace-slots.sh` using the selected capacity
   from PR #8 when merged; on this base revision, the fixed sixteen-slot behavior still applies.
   Use the live steps from [executor-host.md](executor-host.md). Never shrink existing images
   in place.
3. **Create isolated credentials:** Install only the new executor deployment *public* SSH key.
   Create new executor token and admission secret on the host. Populate its `executor.env`;
   transfer corresponding values to dashboard `control-plane.env` using an approved secure
   channel. Keep the dashboard SSH key unchanged.
4. **Install private HTTPS edge:** Supply new executor IPv4 and dashboard source IPv4 explicitly
   as shown above. Verify the new CA/server certificate fingerprint out-of-band, its SAN for
   the new executor address, and UFW's deny-default policy. Install only the **public** CA
   certificate on the dashboard trust path (`POLYTRONX_EXECUTOR_CA_FILE`). The edge must
   refuse requests from hosts other than the dashboard.
5. **Verify artifacts:** Build the pinned release through the repository's CI workflow and
   check `SHA256SUMS` before loading `executor.tar`. Run the executor preflight and its
   bounded health/sandbox acceptance tests in a **non-production** test route first.
6. **Switch control-plane destination only after readiness:** Update
   `VPS_EXECUTOR_URL=https://<new-executor-address>:19443`, the executor token and admission
   secret, and the trusted CA certificate on the **permanent dashboard VPS**. Follow
   [deploy-and-rollback.md](deploy-and-rollback.md) for backed-up, authenticated, health-checked
   control-plane configuration changes. Avoid re-deploying the dashboard image when only
   approved executor connection settings must change; the current Compose setup may require
   a controlled service recreation to read them.
7. **Accept and observe:** Verify the executor HTTPS health from the dashboard, then a
   deliberately authorized sandbox create/stop smoke test. Verify network isolation and
   gVisor. Re-enable new admissions only after these checks pass.
8. **Revoke the old executor:** Once workspaces and in-flight jobs are settled, remove its
   previous SSH deploy key, old shared token, firewall grants and CA trust, then terminate
   the old host. Rotate the GitHub `executor-production` host, fingerprint and secret values.
   The `dashboard-production` environment remains unchanged.

### Failed cutover

Do not automatically fall back to an executor whose token or CA has been revoked. Keep the
old host running but drained while investigating. A rollback requires restoring its verified
token, trusted CA and endpoint using the backed-up configuration, then repeating private-edge
and sandbox smoke checks before resuming admissions. Never delete the old host until that
recovery boundary has been tested.

## Evidence required before final production deployment

- PR checks green **at their exact final commit SHA**; full pinned-release workflow passes.
- Both GitHub environments and host-key fingerprints independently verified.
- Dashboard backup/restore rehearsal and controlled rollback verified.
- New executor preflight, private edge, gVisor, firewall, admission and capacity gates pass.
- Workspace/drain inventory reconciled, no live jobs will be abandoned.
- Operator approval of the actual host and release revision.

This runbook describes the path forward; it does not establish that any live VPS has been changed.
