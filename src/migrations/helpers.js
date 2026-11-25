/**
 * Idempotent schema helpers. Work on MySQL 5.7, MySQL 8 and MariaDB 10.x.
 */
export async function columnExists(db, table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

export async function addColumnIfMissing(db, table, column, definition) {
  if (!(await columnExists(db, table, column))) {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

export async function indexExists(db, table, indexName) {
  const [rows] = await db.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, indexName]
  );
  return rows.length > 0;
}

export async function addIndexIfMissing(db, table, indexName, definition) {
  if (!(await indexExists(db, table, indexName))) {
    await db.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
  }
}

export const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
