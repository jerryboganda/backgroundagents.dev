-- sandbox_admission_reservations: durable occupancy of the global sandbox
-- admission gate, checked before any sandbox allocation.
--
-- A row exists exactly while its slot is occupied, so the primary key on
-- (scope, slot) is the occupancy constraint. A claim is INSERT ... ON CONFLICT
-- (scope, slot) DO NOTHING; meta.changes = 1 means the slot was taken.
--
-- States:
--   reserved    claimed; no provider call has been recorded under this lease
--   allocating  provider call recorded under this lease before it is made
--   allocated   provider object referenced by modal_object_id; no lease
--   unknown     a lapsed or ambiguous reserved/allocating lease; it keeps the
--               slot until provider lookup settles it
--
-- Only reserved and allocating carry a lease. A lapsed lease moves to unknown;
-- it never frees the slot by itself. Release deletes the row, after shutdown is
-- confirmed or a provider lookup finds no object.
--
-- session_id takes no ON DELETE action on purpose: deleting a session that
-- holds a slot is refused, not cascaded into freeing it. A migration that
-- rebuilds sessions must therefore release occupied slots first.
--
-- scope is 'global' for now. The deployment limit is the slot count; changing
-- it means widening the slot CHECK in a new migration and SANDBOX_ADMISSION_SLOTS
-- together.
CREATE TABLE sandbox_admission_reservations (
  scope            TEXT    NOT NULL,
  slot             INTEGER NOT NULL CHECK (slot IN (0, 1)),
  lease_token      TEXT    NOT NULL UNIQUE,
  session_id       TEXT    NOT NULL,
  generation       INTEGER NOT NULL,
  operation_ref    TEXT    NOT NULL,
  state            TEXT    NOT NULL CHECK (state IN ('reserved', 'allocating', 'allocated', 'unknown')),
  modal_object_id  TEXT,
  lease_expires_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (scope, slot),
  CHECK (state <> 'allocated' OR modal_object_id IS NOT NULL),
  CHECK ((state IN ('reserved', 'allocating')) = (lease_expires_at IS NOT NULL)),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
