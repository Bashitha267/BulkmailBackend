import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { one, isDbReady } from '../config/db.js';

export function serializeUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    role: u.role,
    initials: u.initials,
    teamName: u.team_name,
    status: u.status,
  };
}

/** Verifies the Bearer token and loads the current user from MySQL. */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ success: false, message: 'Sign in to continue.' });

  let decoded;
  try {
    decoded = jwt.verify(token, env.jwtSecret);
  } catch {
    return res.status(401).json({ success: false, message: 'Your session expired. Sign in again.' });
  }
  if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database is starting up. Try again shortly.' });

  try {
    const user = await one('SELECT * FROM users WHERE id = ?', [decoded.id]);
    if (!user || user.status !== 'active') {
      return res.status(401).json({ success: false, message: 'This account no longer has access.' });
    }
    // Tokens issued before a password change stop working.
    if (user.password_changed_at && decoded.iat * 1000 < new Date(user.password_changed_at).getTime() - 1000) {
      return res.status(401).json({ success: false, message: 'Your password changed. Sign in again.' });
    }
    req.user = serializeUser(user);
    return next();
  } catch (err) {
    return next(err);
  }
}

const RANK = { Viewer: 1, Editor: 2, Owner: 3 };

/** requireRole('Editor') lets Editors and Owners through. */
export function requireRole(minRole) {
  return (req, res, next) => {
    if ((RANK[req.user?.role] || 0) >= RANK[minRole]) return next();
    return res.status(403).json({
      success: false,
      message: minRole === 'Owner' ? 'Only the owner can change this.' : 'Viewers can only see reports.',
    });
  };
}

/** Write methods need Editor; reads are open to everyone signed in. */
export function editorsWrite(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  return requireRole('Editor')(req, res, next);
}

export function requireDb(_req, res, next) {
  if (isDbReady()) return next();
  return res.status(503).json({ success: false, message: 'Database is starting up. Try again shortly.' });
}

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}
