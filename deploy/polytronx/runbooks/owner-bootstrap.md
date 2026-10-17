# Owner bootstrap (Node / SQLite)

Upstream's owner bootstrap runs against remote D1, through Wrangler, with Cloudflare
credentials (`scripts/bootstrap-workspace-owner.ts`). The container deployment has
no equivalent upstream. `scripts/bootstrap-node-owner.ts` is that equivalent. It
uses the same SQL, verified against the same schema, and it runs against the
live store file inside the control plane's own image.

## What it does

- Refuses unless the store exists. It never creates a database.
- Refuses unless the ledger records migrations 0071, 0072 and 0073 by their exact
  names. Those define the owner role and the audit table's shape.
- Dry run (the default) opens the store read-only and prints the preflight report.
  It writes nothing.
- `--execute` takes the write lock first, runs the preflight under it, then in one
  transaction inserts one audit row (`workspace.owner_bootstrapped`, service
  principal `operator-cli`) and changes the user's single role assignment to Owner.
  It verifies the postcondition, then commits. Any failure rolls back everything.
- A second run reports `no-op` and writes nothing.

## Refusals and why

| Reason | Meaning | Action |
|---|---|---|
| `target user does not exist exactly once` | The user has not signed in. First sign-in creates the canonical user with the Member role. | Sign in through the allowlist, then rerun. |
| `target user is suspended` | The user is suspended. | Unsuspend through the app, or choose another user. |
| `another unsuspended Owner already exists` | Second-admin safeguard. The bootstrap creates the first Owner only. | Manage ownership in the app. Do not bypass. |
| `required RBAC schema is missing or incomplete` | The store's audit table is not the RBAC shape. | Stop. Check the migration ledger and the release. |
| `not recorded; this store's RBAC schema is not verified` | A migration name differs from the verified file. | Stop. Do not edit the ledger. |
| `No database file at ...` | Wrong path. | Check the path under `/data`. |

## Procedure (owner, on the VPS, after a verified deploy)

1. Find the canonical user ID for the owner's sign-in. It is the 32-character
   lowercase hex value in the store's `users` table. This read-only query lists IDs
   and display names. Keep its output on the VPS, and do not paste it into a chat:

       docker compose -p polytronx-openinspect --env-file state/release.env \
         -f source/deploy/polytronx/compose.production.yml exec -T app \
         node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('/data/global.db', { readOnly: true }); console.log(db.prepare('SELECT id, display_name FROM users ORDER BY created_at').all());"
2. Dry run:

       source/deploy/polytronx/owner-bootstrap.sh \
         --release state/release.env --source source --user <32-hex-id>

   Read the `preflight` line. It must say `ready`.
3. Execute, only after reading the report:

       source/deploy/polytronx/owner-bootstrap.sh \
         --release state/release.env --source source --user <32-hex-id> --execute

   The output ends with `Owner bootstrap committed`.
4. Verify. Rerun step 2. It must report `no-op`. Sign in as the owner and open the
   workspace administration page. Confirm the page loads with owner permissions.
   The audit query in `authorization_audit_events` should show one
   `workspace.owner_bootstrapped` row with `operation_result = applied`. Record the
   result in the evidence register.

Whether the running control plane applies the new role without a restart is not
verified by any check in this package. Step 4 is the test. If the owner still has
Member permissions after a sign-out and sign-in, stop and investigate before any
restart. Do not restart to paper over it.

## Tests

`scripts/bootstrap-node-owner.test.ts` runs the bootstrap against temporary stores
built from the repository's real migration files. It covers the dry run's
read-only behavior, a committed assignment that survives reopening, idempotence,
the second-Owner refusal and its suspended-owner exception, a suspended target,
an unknown user, rollback when the assignment write fails, schema and ledger
refusals, the no-create guard, and the CLI exit codes. Run it with:

    node --experimental-transform-types --test scripts/bootstrap-node-owner.test.ts
