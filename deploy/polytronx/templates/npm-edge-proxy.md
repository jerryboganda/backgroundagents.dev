# Nginx Proxy Manager: edge routes for ai, cp and public docs

Owner-run steps in the existing NPM web UI. Do not edit NPM's generated files on disk, and do not
restart NPM. The routes reach the three services by container name over the dedicated
`polytronx-edge` network, not through host loopback. Docker cannot route a container to a
loopback-only published port, so the loopback ports serve only host-local checks.

## Gate 0: attach NPM to the edge network (owner authorization required)

Once, after `deploy.sh` has created `polytronx-edge`:

    docker network connect polytronx-edge <npm-container-name>

This adds a network attachment to the existing NPM container. It does not restart it, but it changes
an existing container, so it needs the owner's explicit approval. Afterwards NPM can resolve
`polytronx-openinspect-web`, `polytronx-openinspect-app` and `polytronx-openinspect-docs`. Revert
with `docker network disconnect` if needed.

## Route 1: ai.polytronx.com (web)

Proxy Hosts, Add Proxy Host. The existing ai host (for omo, behind Basic Auth) is replaced only
after the owner authorizes it. See Route 3.

- Domain Names: `ai.polytronx.com`
- Scheme: `http`; Forward Hostname: `polytronx-openinspect-web`; Forward Port: `3000`
- Cache Assets: off. Block Common Exploits: on. Websockets Support: on.
- SSL: request a certificate for `ai.polytronx.com`. Force SSL: on. HTTP/2: on. HSTS: enable only
  after the certificate is confirmed.
- Advanced (custom Nginx directives, as text in the UI):

      access_log off;
      client_max_body_size 32m;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
      add_header X-Content-Type-Options nosniff always;
      add_header Referrer-Policy strict-origin-when-cross-origin always;

  Do not add a Content-Security-Policy here. The dashboard's own headers and its authentication
  cookies are left as the application sets them.

  `access_log off` is required for this host, not optional. Sign-in returns GitHub's one-time `code`
  and `state` in the query string of `/api/auth/callback/github`, and an access log would record
  them. nginx's error log can still record a request line when an upstream request fails, so do not
  raise its level or copy it off the host. Route 2 keeps its access log: no credential travels in
  its URLs. The WebSocket token is sent in the first message, not in the URL. After one sign-in,
  grep this host's NPM log files for `code=` and `state=`; both must find nothing.

## Route 2: cp.ai.polytronx.com (control plane, HTTP API and WebSockets)

- Domain Names: `cp.ai.polytronx.com`
- Scheme: `http`; Forward Hostname: `polytronx-openinspect-app`; Forward Port: `8787`
- Websockets Support: **on**. Sessions stream over `/sessions/:id/ws`.
- Block Common Exploits: on. Cache Assets: off.
- SSL: as Route 1, with the same certificate procedure for `cp.ai.polytronx.com`.
- Advanced:

      client_max_body_size 32m;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;

The DNS record for `cp.ai.polytronx.com` does not exist yet (NXDOMAIN at the audit). The owner
creates it. Confirm whether it is DNS-only or proxied before requesting a certificate: an HTTP-01
challenge needs the name to reach this host.

## Route 3: docs.backgroundagents.dev (public documentation)

For `docs.backgroundagents.dev`, add a separate Proxy Host after the reviewed docs container is
healthy: scheme `http`, forward hostname `polytronx-openinspect-docs`, forward port `3000`, HTTPS
enabled. Point the hostname's DNS record to the dashboard VPS (`185.252.233.186`) and confirm the
certificate before publishing. The docs container shares the edge network; do not route the docs
domain to the dashboard UI.

## Replacing the existing ai host (owner authorization required)

The current ai host forwards to `omo:7681` behind Basic Auth. The owner has authorized replacing
that application. Sequence:

1. Confirm no other service depends on that host (the audit found no matching omo container or
   alias).
2. Use Route 1 to create the new host. Verify it end to end (runbooks/evidence-register.md).
3. Disable the old host in the UI. Do not delete it yet.
4. After the new route passes, delete the old host in the UI. Record that deletion in the evidence
   register with the time.

Rollback at any step: re-enable the old host in the UI. Nothing is deleted before step 4.

## Verification from outside the host (owner)

    curl -sI https://ai.polytronx.com/ | head -n1          # 200, 307 or 308
    curl -s  https://cp.ai.polytronx.com/healthz            # {"status":"ok",...}
    curl -fI https://docs.backgroundagents.dev/             # 200

WebSocket streaming needs a browser: open a session, watch it stream, reload, and confirm it
reattaches. Record the result in the evidence register.
