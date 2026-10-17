-- sandbox_admission_reservations.relinquished_at: when the owning session moved past this lease's generation
-- and so no longer uses its allocated object. The owner durably writes it before its replacement generation is
-- written, so the reconcile hook can stop and free that object without waiting for a newer lease to supersede it.
-- NULL on every row the owner has not relinquished, which is every row that predates this migration.
ALTER TABLE sandbox_admission_reservations ADD COLUMN relinquished_at INTEGER;
