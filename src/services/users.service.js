import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { query, one } from '../config/db.js';
import { initialsOf } from '../lib/util.js';

/**
 * Creates or updates the owner account from ADMIN_USERNAME / ADMIN_PASSWORD.
 * Lets you take over from the old demo login without touching the database.
 */
export async function bootstrapAdmin() {
  const { username, password, email, resetPassword } = env.admin;
  if (!username || !password) return;
  if (password.length < 10) {
    console.warn('[auth] ADMIN_PASSWORD is shorter than 10 characters, ignoring it.');
    return;
  }
  const existing = await one('SELECT id FROM users WHERE username = ?', [username]);
  const hash = await bcrypt.hash(password, 12);
  if (!existing) {
    const team = (await one('SELECT team_name FROM users ORDER BY id LIMIT 1'))?.team_name || 'Acme Team';
    await query(
      `INSERT INTO users (username, password_hash, name, email, role, initials, team_name, password_changed_at)
       VALUES (?, ?, ?, ?, 'Owner', ?, ?, UTC_TIMESTAMP())`,
      [username, hash, 'Admin', email || username, initialsOf('Admin'), team]
    );
    console.log(`[auth] Created owner account "${username}".`);
  } else if (resetPassword) {
    await query("UPDATE users SET password_hash = ?, status = 'active', password_changed_at = UTC_TIMESTAMP() WHERE id = ?", [
      hash,
      existing.id,
    ]);
    console.log(`[auth] Reset password for "${username}". Remove ADMIN_RESET_PASSWORD now.`);
  }
}

const KNOWN_DEFAULT = 'password123';

/** True while an account still uses the password the old version shipped with. */
export async function usesDefaultPassword(user) {
  const row = await one('SELECT password_hash FROM users WHERE id = ?', [user.id]);
  return row ? bcrypt.compare(KNOWN_DEFAULT, row.password_hash) : false;
}

export async function warnAboutDefaultPassword() {
  const demo = await one("SELECT id, password_hash FROM users WHERE username = 'demo' AND status = 'active'");
  if (demo && (await bcrypt.compare(KNOWN_DEFAULT, demo.password_hash))) {
    console.warn(
      '[auth] WARNING: the "demo" account still uses password123. Change it in Settings, ' +
        'or set ADMIN_USERNAME/ADMIN_PASSWORD and disable the demo user.'
    );
  }
}
