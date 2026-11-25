import { importWorkspaceSnapshot, readLegacySnapshot } from '../lib/importWorkspace.js';

/**
 * Copies data saved by the old version (one JSON blob in workspace_state) into
 * the new tables. The blob is kept, renamed, as a backup. Fresh installs skip this.
 */
export default {
  version: '005_import_legacy_workspace',
  name: 'Import legacy workspace_state JSON into relational tables',
  async up(db) {
    const [tables] = await db.query(
      "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_state'"
    );
    if (!tables.length) return;
    const snapshot = await readLegacySnapshot(db);
    if (!snapshot) return;

    const counts = await importWorkspaceSnapshot(db, snapshot);
    console.log('[migrate] Imported legacy workspace:', JSON.stringify(counts));

    await db.query("DELETE FROM workspace_state WHERE state_key = 'main_backup_before_005'");
    await db.query("UPDATE workspace_state SET state_key = 'main_backup_before_005' WHERE state_key = 'main'");
  },
};
