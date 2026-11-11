-- Task list cleanup, 2026-11-11. Data only, no schema change.
-- Closes five Back of house tasks that are fixed or no longer apply, each with a
-- closing note, and files one business task for the Notion import.
-- Every UPDATE matches the task's id AND the start of its title, so a different
-- database with other tasks at these ids is left alone. On a fresh database (the
-- tests) the UPDATEs touch nothing and the INSERT is skipped.

-- #41: WSL2 setup. Windows is gone; the laptop runs Ubuntu 26.04 natively.
UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now'),
  notes = coalesce(notes || char(10) || char(10), '') || 'Closed 2026-11-11: obsolete. Windows was replaced by Ubuntu 26.04, so WSL2 is not needed; git and gh run natively.'
WHERE id = 41 AND title LIKE '[S2.1][CC] Install WSL2%' AND status <> 'done';

-- #48: Tailscale.
UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now'),
  notes = coalesce(notes || char(10) || char(10), '') || 'Closed 2026-11-11: Tailscale is running on the Ubuntu laptop (SSH allowed only on tailscale0). Phone and SSO roll into the open remote-access decision (Tailscale vs Cloudflare SSH).'
WHERE id = 48 AND title LIKE '[S3.2][BB+CC] Tailscale%' AND status <> 'done';

-- #57: intake form blocked by the "All Workers" Access app.
UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now'),
  notes = coalesce(notes || char(10) || char(10), '') || 'Closed 2026-11-11: fixed. Added the Access app "becs-intake public form (bypass)" with an app-only bypass; / and /health return 200.'
WHERE id = 57 AND title LIKE '[infra] web:becs-intake %' AND status <> 'done';

-- #58 and #59: anonymous requests to the console and /api/me are refused by Cloudflare Access.
UPDATE tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now'),
  notes = coalesce(notes || char(10) || char(10), '') || 'Closed 2026-11-11: anonymous requests are refused by Cloudflare Access (403 block page, not the Worker). The stray "Bypass api" policy was deleted. infra-watch still expects a login redirect, so it reads the 403 as a failure until it is taught to accept it.'
WHERE ((id = 58 AND title LIKE '[infra] web:becs-os-console %')
    OR (id = 59 AND title LIKE '[infra] web:becs-os-api-me %')) AND status <> 'done';

-- New business task: bring BECS-only content over from Notion. Filed under the
-- BECS venture (looked up by slug) so it shows when BECS is selected.
INSERT INTO tasks (venture_id, title, status, priority, filter_tag, notes)
SELECT (SELECT id FROM ventures WHERE slug = 'becs'), 'Import BECS-only Notion content into BECS OS', 'todo', 3, 'systems',
  'Source: the BECS Team Space page in Notion (internal BECS databases). Skip the "Archive - Nov 2026 cleanup" page; dead ventures and personal items stay out.'
WHERE EXISTS (SELECT 1 FROM tasks WHERE id = 41 AND title LIKE '[S2.1][CC] Install WSL2%')
  AND EXISTS (SELECT 1 FROM ventures WHERE slug = 'becs')
  AND NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Import BECS-only Notion content into BECS OS'
                    AND venture_id = (SELECT id FROM ventures WHERE slug = 'becs'));
