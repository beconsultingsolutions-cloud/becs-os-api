-- 0003 milestones and client log (piece B of the BECS Build Plan)
--  (a) milestones: the ordered steps of a project's engagement (M0 ... M5, or lifecycle stages).
--  (b) client_notes: a running history per client (calls, meetings, decisions, links).
--  (c) tasks.milestone_id: a task can belong to a milestone.
-- Additive only: no existing table is rebuilt, no existing row changes.
-- D1 runs each migration file inside its own transaction, so there is no BEGIN/COMMIT here.

-- (a)
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  position INTEGER,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
  due_date TEXT,
  met_when TEXT,
  notes TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_milestones_project ON milestones(project_id, position);
CREATE INDEX idx_milestones_status_due ON milestones(status, due_date);

-- (b)
CREATE TABLE client_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'call', 'meeting', 'email', 'decision', 'link')),
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  happened_on TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_client_notes_client ON client_notes(client_id, happened_on);

-- (c)
ALTER TABLE tasks ADD COLUMN milestone_id INTEGER REFERENCES milestones(id);
CREATE INDEX idx_tasks_milestone ON tasks(milestone_id);
