#!/usr/bin/env node
/**
 * SceneForge one-time world repair utility.
 *
 * Purpose:
 *   Repair invalid Foundry JournalEntryPage records left by old module data by
 *   converting page type "mastercrafted.mastercrafted" to "text".
 *
 * Important:
 *   - This is NOT runtime module logic.
 *   - Run this once against world data files while Foundry is stopped.
 *   - The script creates a backup before it writes any file.
 */

import fs from "node:fs/promises";
import path from "node:path";

const INVALID_TYPE = "mastercrafted.mastercrafted";
const REPLACEMENT_TYPE = "text";

function printUsage() {
  console.log("Usage:");
  console.log("  node scripts/repair-journal-page-types.mjs <journal.db-or-directory> [--dry-run]");
  console.log("");
  console.log("Examples:");
  console.log("  node scripts/repair-journal-page-types.mjs \"/path/to/Data/worlds/MyWorld/data/journal.db\"");
  console.log("  node scripts/repair-journal-page-types.mjs \"/path/to/Data/worlds\"");
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildFallbackPageText(page) {
  const direct = page?.text?.content
    ?? page?.content
    ?? page?.markdown
    ?? page?.html
    ?? "";
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct;
  }

  const serialized = JSON.stringify(page, null, 2) ?? "{}";
  return `<pre>${htmlEscape(serialized)}</pre>`;
}

function repairPage(page) {
  if (!page || typeof page !== "object") return { page, changed: false };
  if (page.type !== INVALID_TYPE) return { page, changed: false };

  const repaired = { ...page, type: REPLACEMENT_TYPE };
  if (!repaired.text || typeof repaired.text !== "object") {
    repaired.text = {
      format: 1,
      content: buildFallbackPageText(page)
    };
  } else if (typeof repaired.text.content !== "string" || repaired.text.content.trim().length === 0) {
    repaired.text = {
      ...repaired.text,
      format: Number.isFinite(Number(repaired.text.format)) ? Number(repaired.text.format) : 1,
      content: buildFallbackPageText(page)
    };
  }

  return { page: repaired, changed: true };
}

function repairJournalDoc(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.pages)) {
    return { doc, changed: false, pagesChanged: 0 };
  }

  let changed = false;
  let pagesChanged = 0;
  const nextPages = doc.pages.map((page) => {
    const result = repairPage(page);
    if (result.changed) {
      changed = true;
      pagesChanged += 1;
    }
    return result.page;
  });

  if (!changed) {
    return { doc, changed: false, pagesChanged: 0 };
  }

  return {
    doc: { ...doc, pages: nextPages },
    changed: true,
    pagesChanged
  };
}

function tryParseWholeJson(raw) {
  try {
    return { kind: "json", value: JSON.parse(raw) };
  } catch (_error) {
    return null;
  }
}

function parseNdjson(raw) {
  const lines = raw.split(/\r?\n/);
  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) {
      parsed.push({ blank: true, raw: line });
      continue;
    }
    parsed.push({ blank: false, value: JSON.parse(line) });
  }
  return parsed;
}

function renderNdjson(rows) {
  return `${rows.map((row) => (row.blank ? "" : JSON.stringify(row.value))).join("\n")}\n`;
}

async function resolveJournalTargets(inputPath) {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) return [path.resolve(inputPath)];

  const targets = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && entry.name === "journal.db") {
        targets.push(path.resolve(full));
      }
    }
  }

  await walk(path.resolve(inputPath));
  return targets;
}

async function repairJournalFile(filePath, { dryRun }) {
  const raw = await fs.readFile(filePath, "utf8");
  if (!raw.includes(INVALID_TYPE)) {
    return { filePath, scanned: true, changed: false, pagesChanged: 0, docsChanged: 0, backupPath: null };
  }

  let pagesChanged = 0;
  let docsChanged = 0;
  let nextRaw = raw;

  const wholeJson = tryParseWholeJson(raw);
  if (wholeJson) {
    const value = wholeJson.value;
    if (Array.isArray(value)) {
      const repaired = value.map((doc) => {
        const result = repairJournalDoc(doc);
        if (result.changed) {
          pagesChanged += result.pagesChanged;
          docsChanged += 1;
        }
        return result.doc;
      });
      nextRaw = `${JSON.stringify(repaired, null, 2)}\n`;
    } else {
      const result = repairJournalDoc(value);
      if (result.changed) {
        pagesChanged += result.pagesChanged;
        docsChanged += 1;
      }
      nextRaw = `${JSON.stringify(result.doc, null, 2)}\n`;
    }
  } else {
    const rows = parseNdjson(raw);
    const repairedRows = rows.map((row) => {
      if (row.blank) return row;
      const result = repairJournalDoc(row.value);
      if (result.changed) {
        pagesChanged += result.pagesChanged;
        docsChanged += 1;
      }
      return { ...row, value: result.doc };
    });
    nextRaw = renderNdjson(repairedRows);
  }

  if (pagesChanged === 0) {
    return { filePath, scanned: true, changed: false, pagesChanged: 0, docsChanged: 0, backupPath: null };
  }

  const backupPath = `${filePath}.bak-${timestampLabel()}`;
  if (!dryRun) {
    // Backup is created before any write to preserve a full restore point.
    await fs.copyFile(filePath, backupPath);
    await fs.writeFile(filePath, nextRaw, "utf8");
  }

  return { filePath, scanned: true, changed: true, pagesChanged, docsChanged, backupPath };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const targetArg = args.find((arg) => !arg.startsWith("--"));
  if (!targetArg) {
    printUsage();
    process.exit(1);
  }

  const resolvedTarget = path.resolve(targetArg);
  const journalFiles = await resolveJournalTargets(resolvedTarget);
  if (journalFiles.length === 0) {
    console.log(`No journal.db files found under: ${resolvedTarget}`);
    process.exit(0);
  }

  console.log(`Scanning ${journalFiles.length} journal.db file(s) for "${INVALID_TYPE}"...`);
  let totalDocsChanged = 0;
  let totalPagesChanged = 0;
  let filesChanged = 0;

  for (const journalFile of journalFiles) {
    const result = await repairJournalFile(journalFile, { dryRun });
    if (!result.changed) {
      console.log(`- ${journalFile}: no changes`);
      continue;
    }

    filesChanged += 1;
    totalDocsChanged += result.docsChanged;
    totalPagesChanged += result.pagesChanged;
    console.log(`- ${journalFile}: repaired ${result.pagesChanged} page(s) across ${result.docsChanged} journal entrie(s)`);
    if (!dryRun && result.backupPath) {
      console.log(`  backup: ${result.backupPath}`);
    }
  }

  console.log("");
  if (dryRun) {
    console.log(`Dry run complete. Files needing repair: ${filesChanged}`);
  } else {
    console.log(`Repair complete. Files changed: ${filesChanged}`);
  }
  console.log(`Journal entries repaired: ${totalDocsChanged}`);
  console.log(`Journal pages repaired: ${totalPagesChanged}`);
}

main().catch((error) => {
  console.error("Repair failed:", error?.stack ?? error);
  process.exit(1);
});
