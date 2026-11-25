import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { findMysqlUserByUsername, isMysqlConnected } from '../config/mysql.js';

const router = Router();

// Pre-hashed password for 'password123' (cost 10) computed once at startup
const DEMO_USER = {
  id: 1,
  username: 'demo',
  passwordHash: bcrypt.hashSync('password123', 10),
  name: 'Admin',
  email: 'admin@example.com',
  role: 'Owner',
  initials: 'AD',
  teamName: 'Acme Team',
};

/**
 * Lookup user by username.
 * Ready to be replaced with a MySQL query when database is connected.
 */
async function findUserByUsername(username) {
  if (isMysqlConnected()) {
    const mysqlUser = await findMysqlUserByUsername(username);
    if (mysqlUser) return mysqlUser;
  }
  if (username.toLowerCase() === DEMO_USER.username) {
    return DEMO_USER;
  }
  return null;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please try again in 15 minutes.',
  },
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required.',
      });
    }

    const user = await findUserByUsername(username.trim());
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password.',
      });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid username or password.',
      });
    }

    const payload = {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      initials: user.initials,
      teamName: user.teamName,
    };

    const token = jwt.sign(payload, env.jwtSecret, {
      expiresIn: env.jwtExpiresIn,
    });

    return res.json({
      success: true,
      token,
      user: payload,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  return res.json({
    success: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      initials: req.user.initials,
      teamName: req.user.teamName,
    },
  });
});

router.post('/logout', (_req, res) => {
  return res.json({
    success: true,
    message: 'Logged out successfully.',
  });
});

export default router;
