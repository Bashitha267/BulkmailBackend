import { addColumnIfMissing, addIndexIfMissing, TABLE_OPTIONS } from './helpers.js';

/**
 * Moves the app from one JSON blob (workspace_state) to real tables.
 * Every step is idempotent so a half-finished deploy can simply run again.
 */
export default {
  version: '004_relational_core',
  name: 'Relational tables for contacts, groups, campaigns, recipients, events, settings',
  async up(db) {
    // Old tables were created with the server's default collation. New tables use
    // utf8mb4_unicode_ci (works on MySQL 5.7, 8 and MariaDB). Joins between tables
    // with different collations fail, so convert the old ones to match first.
    const [tables] = await db.query(
      `SELECT TABLE_NAME, TABLE_COLLATION FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
         ('users','contacts','groups_list','templates','campaigns','media_assets','workspace_state','schema_migrations')`
    );
    for (const t of tables) {
      if (t.TABLE_COLLATION !== 'utf8mb4_unicode_ci') {
        await db.query(`ALTER TABLE \`${t.TABLE_NAME}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      }
    }

    // ---- users ---------------------------------------------------------------
    await addColumnIfMissing(db, 'users', 'status', "VARCHAR(20) NOT NULL DEFAULT 'active'");
    await addColumnIfMissing(db, 'users', 'last_login_at', 'DATETIME NULL');
    await addColumnIfMissing(db, 'users', 'password_changed_at', 'DATETIME NULL');

    // ---- contacts --------------------------------------------------------------
    await db.query('ALTER TABLE contacts MODIFY groups_json JSON NULL');
    await addColumnIfMissing(db, 'contacts', 'first_name', "VARCHAR(120) NOT NULL DEFAULT ''");
    await addColumnIfMissing(db, 'contacts', 'last_name', "VARCHAR(120) NOT NULL DEFAULT ''");
    await addColumnIfMissing(db, 'contacts', 'custom_fields_json', 'JSON NULL');
    await addColumnIfMissing(db, 'contacts', 'preferences_json', 'JSON NULL');
    await addColumnIfMissing(db, 'contacts', 'unsub_token', 'CHAR(32) NULL');
    await addColumnIfMissing(db, 'contacts', 'status_changed_at', 'DATETIME NULL');
    await addColumnIfMissing(db, 'contacts', 'last_activity_at', 'DATETIME NULL');
    await addColumnIfMissing(db, 'contacts', 'sent_count', 'INT NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'contacts', 'open_count', 'INT NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'contacts', 'click_count', 'INT NOT NULL DEFAULT 0');
    await addColumnIfMissing(
      db,
      'contacts',
      'updated_at',
      'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    );
    await addIndexIfMissing(db, 'contacts', 'uq_contacts_unsub_token', 'UNIQUE INDEX uq_contacts_unsub_token (unsub_token)');
    await addIndexIfMissing(db, 'contacts', 'ix_contacts_status', 'INDEX ix_contacts_status (status)');
    await addIndexIfMissing(db, 'contacts', 'ix_contacts_created', 'INDEX ix_contacts_created (created_at)');

    // ---- groups ----------------------------------------------------------------
    await addIndexIfMissing(db, 'groups_list', 'ix_groups_name', 'INDEX ix_groups_name (name)');
    await db.query(`
      CREATE TABLE IF NOT EXISTS contact_groups (
        contact_id VARCHAR(190) NOT NULL,
        group_id VARCHAR(120) NOT NULL,
        added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (contact_id, group_id),
        INDEX ix_cg_group (group_id)
      ) ${TABLE_OPTIONS}
    `);

    // ---- templates -------------------------------------------------------------
    await addColumnIfMissing(
      db,
      'templates',
      'updated_at',
      'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
    );

    // ---- campaigns -------------------------------------------------------------
    const campaignColumns = [
      ['template_id', 'VARCHAR(120) NULL'],
      ['blocks_json', 'JSON NULL'],
      ['topic', "VARCHAR(30) NOT NULL DEFAULT 'newsletter'"],
      ['group_ids_json', 'JSON NULL'],
      ['segment_ids_json', 'JSON NULL'],
      ['send_mode', "VARCHAR(20) NOT NULL DEFAULT 'now'"],
      ['send_at', 'DATETIME NULL'],
      ['timezone', "VARCHAR(64) NOT NULL DEFAULT 'Asia/Colombo'"],
      ['ab_split_pct', 'INT NOT NULL DEFAULT 20'],
      ['ab_wait_hours', 'INT NOT NULL DEFAULT 4'],
      ['ab_decide_at', 'DATETIME NULL'],
      ['ab_winner', 'CHAR(1) NULL'],
      ['started_at', 'DATETIME NULL'],
      ['completed_at', 'DATETIME NULL'],
      ['paused_at', 'DATETIME NULL'],
      ['paused_by', 'VARCHAR(120) NULL'],
      ['total_count', 'INT NOT NULL DEFAULT 0'],
      ['sent_count', 'INT NOT NULL DEFAULT 0'],
      ['delivered_count', 'INT NOT NULL DEFAULT 0'],
      ['opened_count', 'INT NOT NULL DEFAULT 0'],
      ['clicked_count', 'INT NOT NULL DEFAULT 0'],
      ['bounced_count', 'INT NOT NULL DEFAULT 0'],
      ['complaint_count', 'INT NOT NULL DEFAULT 0'],
      ['failed_count', 'INT NOT NULL DEFAULT 0'],
      ['unsubscribed_count', 'INT NOT NULL DEFAULT 0'],
      ['skipped_count', 'INT NOT NULL DEFAULT 0'],
      ['legacy', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['created_by', 'VARCHAR(120) NULL'],
      ['updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
    ];
    for (const [col, def] of campaignColumns) {
      await addColumnIfMissing(db, 'campaigns', col, def);
    }
    await addIndexIfMissing(db, 'campaigns', 'ix_campaigns_status', 'INDEX ix_campaigns_status (status, send_at)');

    // One row per person per campaign. The unique key is what guarantees
    // "nobody gets it twice", even across pause/resume and restarts.
    await db.query(`
      CREATE TABLE IF NOT EXISTS campaign_recipients (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        campaign_id VARCHAR(120) NOT NULL,
        contact_id VARCHAR(190) NULL,
        email VARCHAR(190) NOT NULL,
        name VARCHAR(190) NOT NULL DEFAULT '',
        variant CHAR(1) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        claim_token CHAR(16) NULL,
        claimed_at DATETIME NULL,
        message_id VARCHAR(255) NULL,
        error VARCHAR(500) NULL,
        sent_at DATETIME NULL,
        delivered_at DATETIME NULL,
        opened_at DATETIME NULL,
        clicked_at DATETIME NULL,
        bounced_at DATETIME NULL,
        complained_at DATETIME NULL,
        unsubscribed_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_recipient (campaign_id, email),
        INDEX ix_recipient_queue (status, campaign_id, id),
        INDEX ix_recipient_claim (claim_token),
        INDEX ix_recipient_message (message_id),
        INDEX ix_recipient_contact (contact_id),
        INDEX ix_recipient_sent (sent_at)
      ) ${TABLE_OPTIONS}
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS link_clicks (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        campaign_id VARCHAR(120) NOT NULL,
        url_hash CHAR(40) NOT NULL,
        url VARCHAR(1000) NOT NULL,
        label VARCHAR(255) NOT NULL DEFAULT '',
        clicks INT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_link (campaign_id, url_hash)
      ) ${TABLE_OPTIONS}
    `);

    // Timeline for contacts and campaigns.
    await db.query(`
      CREATE TABLE IF NOT EXISTS events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(40) NOT NULL,
        campaign_id VARCHAR(120) NULL,
        contact_id VARCHAR(190) NULL,
        title VARCHAR(255) NOT NULL,
        detail VARCHAR(500) NOT NULL DEFAULT '',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX ix_events_contact (contact_id, created_at),
        INDEX ix_events_campaign (campaign_id, created_at),
        INDEX ix_events_type (type, created_at)
      ) ${TABLE_OPTIONS}
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        actor VARCHAR(120) NOT NULL,
        action VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX ix_audit_created (created_at)
      ) ${TABLE_OPTIONS}
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS segments (
        id VARCHAR(120) PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        match_type VARCHAR(8) NOT NULL DEFAULT 'any',
        rules_json JSON NULL,
        only_receivable TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ${TABLE_OPTIONS}
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS automations (
        id VARCHAR(120) PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        trigger_type VARCHAR(40) NOT NULL DEFAULT 'group_join',
        trigger_group_id VARCHAR(120) NULL,
        steps_json JSON NULL,
        active TINYINT(1) NOT NULL DEFAULT 0,
        activated_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ${TABLE_OPTIONS}
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS automation_runs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        automation_id VARCHAR(120) NOT NULL,
        contact_id VARCHAR(190) NOT NULL,
        step_index INT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        next_run_at DATETIME NOT NULL,
        claim_token CHAR(16) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_run (automation_id, contact_id),
        INDEX ix_run_due (status, next_run_at)
      ) ${TABLE_OPTIONS}
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS automation_sends (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        run_id BIGINT NOT NULL,
        automation_id VARCHAR(120) NOT NULL,
        contact_id VARCHAR(190) NOT NULL,
        step_index INT NOT NULL,
        template_id VARCHAR(120) NULL,
        email VARCHAR(190) NOT NULL,
        message_id VARCHAR(255) NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        opened_at DATETIME NULL,
        clicked_at DATETIME NULL,
        INDEX ix_as_run (run_id, step_index),
        INDEX ix_as_auto (automation_id),
        INDEX ix_as_message (message_id)
      ) ${TABLE_OPTIONS}
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key VARCHAR(64) PRIMARY KEY,
        value_json JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ${TABLE_OPTIONS}
    `);

    // Test sends count toward the daily limit and the "test sent" go-live step.
    await db.query(`
      CREATE TABLE IF NOT EXISTS test_sends (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        campaign_id VARCHAR(120) NULL,
        email VARCHAR(190) NOT NULL,
        sent_by VARCHAR(120) NOT NULL,
        simulated TINYINT(1) NOT NULL DEFAULT 1,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX ix_test_sent (sent_at)
      ) ${TABLE_OPTIONS}
    `);

    // ---- media: keep image bytes in MySQL so redeploys can't delete them ------
    await addColumnIfMissing(db, 'media_assets', 'mime', "VARCHAR(100) NOT NULL DEFAULT 'image/png'");
    await addColumnIfMissing(db, 'media_assets', 'data', 'LONGBLOB NULL');
  },
};
