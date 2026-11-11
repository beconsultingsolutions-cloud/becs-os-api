-- Back of house: tech upkeep tasks get filter_tag 'maintenance' and move off the
-- dashboard onto their own screen. No schema change (filter_tag is plain TEXT; the
-- allowed values live in src/tables.ts). This only re-tags existing rows:
--   "[infra] ..."  tasks filed by the Chief of Staff's infra-watch check
--   "[S<digit>..." tasks from the security sprint, e.g. "[S1.4][CH+BB] ..."
UPDATE tasks
SET filter_tag = 'maintenance', updated_at = datetime('now')
WHERE title LIKE '[infra]%'
   OR (substr(title, 1, 2) = '[S' AND substr(title, 3, 1) BETWEEN '0' AND '9');
