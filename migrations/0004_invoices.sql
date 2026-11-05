-- 0004 invoices (piece C of the BECS Build Plan)
-- The reserved payments table becomes the invoices table the API exposes.
-- Adds: updated_at, sent_on, milestone_id, notes, a status rule and a non-negative amount rule.
--
-- Why a rebuild (copy, drop, rename) is safe here, unlike projects in 0002: nothing points
-- AT payments (no other table has a foreign key to it), so dropping the old table cannot
-- break a reference. Every existing row is copied with its id. updated_at needs a
-- datetime('now') default, which ALTER TABLE ADD COLUMN cannot give.
-- D1 runs each migration file inside its own transaction, so there is no BEGIN/COMMIT here.

CREATE TABLE payments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  milestone_id INTEGER REFERENCES milestones(id),
  label TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'sent', 'partial', 'paid', 'void')),
  due_date TEXT,
  sent_on TEXT,
  paid_at TEXT,
  square_url TEXT,
  square_invoice_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO payments_new (id, project_id, label, amount_cents, status, due_date, paid_at, square_url, square_invoice_id, created_at, updated_at)
SELECT id, project_id, label,
       CASE WHEN amount_cents < 0 THEN 0 ELSE amount_cents END,
       CASE WHEN status IN ('unpaid', 'sent', 'partial', 'paid', 'void') THEN status ELSE 'unpaid' END,
       due_date, paid_at, square_url, square_invoice_id, created_at, created_at
FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX idx_payments_project ON payments(project_id);
CREATE INDEX idx_payments_square ON payments(square_invoice_id);
CREATE INDEX idx_payments_status_due ON payments(status, due_date);
CREATE INDEX idx_payments_milestone ON payments(milestone_id);
