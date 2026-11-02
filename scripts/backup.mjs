#!/usr/bin/env node
// Back up the live becs-os-core database and prove the backup restores.
//   1. Export the remote D1 database to <backup dir>/becs-os-core-YYYY-MM-DD-HHMM.sql
//   2. Restore that file into a throwaway local database (never the live one)
//   3. Compare row counts per table: live vs restored. Any mismatch fails the run.
//   4. Keep the newest 12 exports; older ones are left for the owner to remove.
// Usage: node scripts/backup.mjs [backup dir]   (default: ~/Documents/becs-os-backups)
// Read-only against the live database. Backups hold client data: never commit them.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DB = "becs-os-core";
const TABLES = ["ventures", "clients", "projects", "tasks", "activity_log", "payments", "portal_links", "milestones", "client_notes"];
const dir = process.argv[2] || join(homedir(), "Documents", "becs-os-backups");
const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16).replace(/[: ]/g, (c) => (c === " " ? "-" : ""));
const file = join(dir, `${DB}-${stamp}.sql`);

// Run the repo's own wrangler through node directly (no shell), so SQL with spaces arrives as one argument.
const WRANGLER = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "wrangler", "bin", "wrangler.js");
const wrangler = (...args) =>
  execFileSync(process.execPath, [WRANGLER, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: join(dirname(fileURLToPath(import.meta.url)), "..") });

function counts(where, persistTo) {
  // One row, one column per table (D1 limits how many UNION terms a query may have).
  const sql = "SELECT " + TABLES.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(", ");
  const args = ["d1", "execute", DB, where, "--json", "--command", sql];
  if (persistTo) args.push("--persist-to", persistTo);
  return JSON.parse(wrangler(...args))[0].results[0];
}

mkdirSync(dir, { recursive: true });

console.log(`1/3 exporting live ${DB} -> ${file}`);
wrangler("d1", "export", DB, "--remote", "--output", file);
const text = readFileSync(file, "utf8");
if (!/CREATE TABLE/i.test(text)) throw new Error("export has no CREATE TABLE statements; not a usable backup");

console.log("2/3 restoring into a throwaway local database");
const scratch = mkdtempSync(join(tmpdir(), "becs-restore-"));
try {
  // The export lists tables in creation order, so rows for an older table (tasks) can come
  // before a newer table it points at (milestones), and SQLite refuses them. For the test
  // restore, create every table first, then load rows and indexes. The saved export is untouched.
  const lines = text.split("\n"), creates = [], rest = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^CREATE TABLE /i.test(lines[i])) {
      const block = [];
      while (i < lines.length) { block.push(lines[i]); if (/;\s*$/.test(lines[i])) break; i++; }
      creates.push(block.join("\n"));
    } else rest.push(lines[i]);
  }
  const pragmas = rest.filter((l) => /^PRAGMA /i.test(l)), body = rest.filter((l) => !/^PRAGMA /i.test(l));
  const restoreFile = join(scratch, "restore.sql");
  writeFileSync(restoreFile, [...pragmas, ...creates, ...body].join("\n"));
  wrangler("d1", "execute", DB, "--local", "--persist-to", scratch, "--file", restoreFile, "--yes");

  console.log("3/3 comparing row counts (live vs restored)");
  const live = counts("--remote"), restored = counts("--local", scratch);
  let ok = true;
  for (const t of TABLES) {
    const same = live[t] === restored[t];
    ok &&= same;
    console.log(`  ${same ? "ok  " : "FAIL"} ${t.padEnd(13)} live ${String(live[t]).padStart(4)}  restored ${String(restored[t]).padStart(4)}`);
  }
  if (!ok) throw new Error("restored counts do not match the live database");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const exports = readdirSync(dir).filter((f) => f.startsWith(DB + "-") && f.endsWith(".sql")).sort();
const old = exports.slice(0, Math.max(0, exports.length - 12));
console.log(`done: ${file} (${Math.round(statSync(file).size / 1024)} KB) restores cleanly. ${exports.length} exports kept${old.length ? `; ${old.length} older than the newest 12 can be removed by hand` : ""}.`);
