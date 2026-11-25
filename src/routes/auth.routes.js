import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { query, one } from '../config/db.js';
import { requireAuth, requireDb, asyncRoute, serializeUser, httpError } from '../middleware/auth.js';
import { usesDefaultPassword } from '../services/users.service.js';
import { audit } from '../services/settings.service.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

// Same work whether or not the user exists, so timing doesn't reveal usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.post(
  '/login',
  loginLimiter,
  requireDb,
  asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      throw httpError(400, 'Enter your username and password.');
    }
    const login = username.trim().toLowerCase();
    const user = await one('SELECT * FROM users WHERE (username = ? OR LOWER(email) = ?) AND status = ? LIMIT 1', [
      login,
      login,
      'active',
    ]);
    const valid = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
    if (!user || !valid) throw httpError(401, 'That username and password don’t match.');

    await query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
    const token = jwt.sign({ id: user.id }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
    const safe = serializeUser(user);
    res.json({ success: true, token, user: { ...safe, insecurePassword: await usesDefaultPassword(safe) } });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json({ success: true, user: { ...req.user, insecurePassword: await usesDefaultPassword(req.user) } });
  })
);

router.post(
  '/change-password',
  requireAuth,
  asyncRoute(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 10) {
      throw httpError(400, 'Use at least 10 characters for the new password.');
    }
    const row = await one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!(await bcrypt.compare(String(currentPassword || ''), row.password_hash))) {
      throw httpError(400, 'Your current password is not right.');
    }
    await query('UPDATE users SET password_hash = ?, password_changed_at = UTC_TIMESTAMP() WHERE id = ?', [
      await bcrypt.hash(newPassword, 12),
      req.user.id,
    ]);
    await audit(req.user.name, 'changed their password');
    const token = jwt.sign({ id: req.user.id }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
    res.json({ success: true, token });
  })
);

router.post('/logout', (_req, res) => res.json({ success: true }));

export default router;
