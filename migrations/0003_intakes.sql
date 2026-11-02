-- Intakes: submissions from the public intake forms, written by the separate becs-intake Worker
-- (Downloads/becs-intake, contract in its HANDOFF.md). becs-os owns status changes after 'new'.
-- Applied to the live database on 2026-11-02 by another session; this file is recorded under the
-- same name in d1_migrations there, so wrangler treats it as already applied. Copied from the live
-- schema; IF NOT EXISTS keeps it harmless on any database that already has the table.
CREATE TABLE IF NOT EXISTS intakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venture_id INTEGER NOT NULL REFERENCES ventures(id),
  client_id INTEGER REFERENCES clients(id),
  form TEXT NOT NULL,
  business_name TEXT,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','call_booked','proposal_sent','closed')),
  answers TEXT NOT NULL,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS intakes_status_idx ON intakes(status, created_at);
CREATE INDEX IF NOT EXISTS intakes_client_idx ON intakes(client_id);
