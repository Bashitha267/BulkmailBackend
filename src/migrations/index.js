import bcrypt from 'bcryptjs';
import { addColumnIfMissing } from './helpers.js';
import m004 from './004_relational_core.js';
import m005 from './005_import_legacy_workspace.js';

export { addColumnIfMissing };

/**
 * Ordered list of database migrations. They run automatically on every start.
 *
 * Rules for adding a change:
 *  1. Append a new entry with the next version number. Never edit or reorder an
 *     entry that has already been deployed.
 *  2. Make each step safe to re-run (IF NOT EXISTS, addColumnIfMissing, ...),
 *     because MySQL commits DDL immediately and a deploy can be interrupted.
 */
export const migrations = [
  {
    version: '001_initial_users_and_workspace_state',
    name: 'Create users and workspace_state tables and seed demo user',
    async up(pool) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          username VARCHAR(64) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(120) NOT NULL,
          email VARCHAR(190) NOT NULL,
          role VARCHAR(40) NOT NULL DEFAULT 'Owner',
          initials VARCHAR(8) NOT NULL DEFAULT 'AD',
          team_name VARCHAR(120) NOT NULL DEFAULT 'Acme Team',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS workspace_state (
          state_key VARCHAR(64) PRIMARY KEY,
          state_value LONGTEXT NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      const [existingUsers] = await pool.query(
        'SELECT id FROM users WHERE username = ? LIMIT 1',
        ['demo']
      );
      if (existingUsers.length === 0) {
        const passwordHash = await bcrypt.hash('password123', 10);
        await pool.query(
          'INSERT INTO users (username, password_hash, name, email, role, initials, team_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['demo', passwordHash, 'Admin', 'admin@example.com', 'Owner', 'AD', 'Acme Team']
        );
      }
    },
  },
  {
    version: '002_normalized_entities',
    name: 'Create contacts, groups_list, templates, and campaigns tables',
    async up(pool) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS contacts (
          id VARCHAR(190) PRIMARY KEY,
          name VARCHAR(190) NOT NULL,
          initials VARCHAR(8) NOT NULL,
          email VARCHAR(190) NOT NULL UNIQUE,
          city VARCHAR(100) DEFAULT '',
          plan VARCHAR(40) DEFAULT 'Free',
          groups_json JSON NOT NULL,
          consent VARCHAR(120) DEFAULT 'Manual entry',
          consent_date VARCHAR(60) DEFAULT '',
          last_activity VARCHAR(120) DEFAULT '',
          status VARCHAR(40) NOT NULL DEFAULT 'Subscribed',
          stats_json JSON,
          consent_record_json JSON,
          activity_json JSON,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS groups_list (
          id VARCHAR(120) PRIMARY KEY,
          name VARCHAR(120) NOT NULL,
          description VARCHAR(255) DEFAULT '',
          default_template VARCHAR(160) DEFAULT 'Monthly newsletter',
          total INT NOT NULL DEFAULT 0,
          can_receive INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS templates (
          id VARCHAR(120) PRIMARY KEY,
          name VARCHAR(160) NOT NULL,
          category VARCHAR(60) DEFAULT 'Newsletter',
          icon VARCHAR(16) DEFAULT '📰',
          subject VARCHAR(255) NOT NULL,
          preview_text VARCHAR(255) DEFAULT '',
          heading VARCHAR(255) DEFAULT '',
          body TEXT,
          cta_label VARCHAR(120) DEFAULT '',
          cta_url VARCHAR(255) DEFAULT '',
          cta_color VARCHAR(20) DEFAULT '#111111',
          blocks_json JSON,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id VARCHAR(120) PRIMARY KEY,
          month VARCHAR(12) NOT NULL,
          day VARCHAR(12) NOT NULL,
          title VARCHAR(255) NOT NULL,
          subtitle VARCHAR(255) DEFAULT '',
          description VARCHAR(255) DEFAULT '',
          status VARCHAR(40) NOT NULL DEFAULT 'Draft',
          subject_a VARCHAR(255) DEFAULT '',
          subject_b VARCHAR(255) DEFAULT '',
          ab_test BOOLEAN NOT NULL DEFAULT FALSE,
          preview_text VARCHAR(255) DEFAULT '',
          from_name VARCHAR(120) DEFAULT 'Acme Team',
          from_email VARCHAR(190) DEFAULT 'news@acme.example.com',
          reply_to VARCHAR(190) DEFAULT '',
          recipients_count INT NOT NULL DEFAULT 0,
          scheduled_date VARCHAR(120) DEFAULT '',
          progress_json JSON,
          stats_json JSON,
          link_clicks_json JSON,
          problems_json JSON,
          activity_json JSON,
          queue_json LONGTEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: '003_media_assets_table',
    name: 'Create media_assets table for uploaded email images',
    async up(pool) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS media_assets (
          id INT AUTO_INCREMENT PRIMARY KEY,
          filename VARCHAR(255) NOT NULL,
          url VARCHAR(500) NOT NULL,
          size_bytes INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  m004,
  m005,
];
