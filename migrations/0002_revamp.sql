-- 0002 revamp
--  (a) projects.phase becomes optional (NULL allowed, no default) and may only be
--      plan / evolve / succeed.
--  (b) activity_log gets an "actor" column (who made the change).
--  (c) a few indexes for the venture filter, dashboard and activity queries.
--
-- D1 runs each migration file inside its own transaction, so there is no BEGIN/COMMIT here.
--
-- Why (a) swaps the column instead of rebuilding the table:
-- SQLite cannot change a column's rules in place. The usual fix (copy projects to
-- a new table, DROP the old one, rename) does NOT work here once tasks or payments
-- point at a project: dropping a table that other rows reference counts as a
-- foreign key violation that is never cleared, even with
-- "PRAGMA defer_foreign_keys = on", so the whole migration is rolled back.
-- Instead we keep the projects table (same rows, same ids, same id counter, same
-- indexes, so every reference stays valid) and replace just the phase column:
-- park the values in a spare column, drop phase, add it back with the new rules,
-- copy the values back, drop the spare column. phase stays the last column.

-- (a)
ALTER TABLE projects ADD COLUMN phase_old TEXT;
UPDATE projects SET phase_old = CASE WHEN phase IN ('plan', 'evolve', 'succeed') THEN phase ELSE NULL END;
ALTER TABLE projects DROP COLUMN phase;
ALTER TABLE projects ADD COLUMN phase TEXT CHECK (phase IN ('plan', 'evolve', 'succeed'));
UPDATE projects SET phase = phase_old;
ALTER TABLE projects DROP COLUMN phase_old;

-- (b) who made each change: "master", "user:<email>" or "app:<name>". Older rows stay NULL.
ALTER TABLE activity_log ADD COLUMN actor TEXT;

-- (c) indexes for the ?venture_id= filters, the dashboard, the delete checks and /api/activity.
CREATE INDEX IF NOT EXISTS idx_tasks_venture_status ON tasks(venture_id, status);
CREATE INDEX IF NOT EXISTS idx_clients_venture ON clients(venture_id);
CREATE INDEX IF NOT EXISTS idx_projects_venture ON projects(venture_id);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
