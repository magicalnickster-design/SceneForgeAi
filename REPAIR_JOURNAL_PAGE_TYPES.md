# One-time Foundry World Repair: Invalid JournalEntryPage Types

This utility repairs bad world data left by older modules where a journal page has:

- `type: "mastercrafted.mastercrafted"`
- `type: "gatherer.gatherer"`

It converts those pages to:

- `type: "text"`

while preserving page name and page text/content as much as possible.

> This is a **one-time world data repair**, not SceneForge runtime logic.

## Script

- `scripts/repair-journal-page-types.mjs`

## Safety Notes

1. Stop Foundry before running the repair.
2. The script creates a backup copy **before** writing any file.
3. Backup paths are printed to stdout.

## Run (single world file)

```bash
node scripts/repair-journal-page-types.mjs "/path/to/Data/worlds/<world-name>/data/journal.db"
```

## Run (scan worlds directory recursively)

```bash
node scripts/repair-journal-page-types.mjs "/path/to/Data/worlds"
```

## Preview only (no writes)

```bash
node scripts/repair-journal-page-types.mjs "/path/to/Data/worlds" --dry-run
```

## What gets changed

For each `JournalEntry` record with `pages[]` entries:

- If page type is one of:
  - `mastercrafted.mastercrafted`
  - `gatherer.gatherer`
  - set `page.type = "text"`
  - preserve existing `page.text` where possible
  - if no compatible text exists, create fallback `text.content` with preserved serialized page data

## Backup/Restore

When a file is changed, backup file name format is:

- `<original-path>.bak-<timestamp>`

Example:

- `/FoundryVTT/Data/worlds/MyWorld/data/journal.db.bak-2026-06-27T00-35-12-100Z`

To restore:

```bash
cp "/path/to/journal.db.bak-<timestamp>" "/path/to/journal.db"
```

Then restart Foundry.
