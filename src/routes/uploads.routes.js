import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';
import { query, one, isDbReady } from '../config/db.js';
import { requireAuth, requireRole, asyncRoute, httpError } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Old versions saved images here. They are still served, but new uploads go to MySQL
// so a redeploy that replaces the app folder can't delete them.
const LEGACY_DIR = env.uploadsDir || path.resolve(__dirname, '../../uploads');
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    ALLOWED.has(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error('Upload a PNG, JPG, GIF or WebP image.'), { status: 400 })),
});

export const uploadsApi = Router();
uploadsApi.post(
  '/',
  requireAuth,
  requireRole('Editor'),
  upload.single('image'),
  asyncRoute(async (req, res) => {
    if (!req.file) throw httpError(400, 'Choose an image to upload.');
    const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[req.file.mimetype];
    const base = path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'image';
    const ins = await query('INSERT INTO media_assets (filename, url, size_bytes, mime, data) VALUES (?, ?, ?, ?, ?)', [
      `${base}${ext}`,
      '',
      req.file.size,
      req.file.mimetype,
      req.file.buffer,
    ]);
    const url = `${env.publicBaseUrl}/uploads/m${ins.insertId}-${base}${ext}`;
    await query('UPDATE media_assets SET url = ? WHERE id = ?', [url, ins.insertId]);
    res.status(201).json({ success: true, url, size: req.file.size });
  })
);

/** Public image URLs used inside emails. */
export const uploadsPublic = Router();
uploadsPublic.get('/:file', async (req, res, next) => {
  const m = /^m(\d+)-/.exec(req.params.file);
  if (m && isDbReady()) {
    const row = await one('SELECT mime, data FROM media_assets WHERE id = ?', [Number(m[1])]).catch(() => null);
    if (row?.data) {
      res.set({ 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end(row.data);
    }
    return res.status(404).end();
  }
  const file = path.join(LEGACY_DIR, path.basename(req.params.file));
  if (fs.existsSync(file)) return res.sendFile(file, { maxAge: '7d' });
  return next();
});
