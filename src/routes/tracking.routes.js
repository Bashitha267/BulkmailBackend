import { Router } from 'express';
import { isDbReady } from '../config/db.js';
import { readTrackingToken, verifySignedUrl } from '../services/render.service.js';
import { recordOpen, recordClick } from '../services/tracking.service.js';

const router = Router();
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

router.get('/o/:token.gif', (req, res) => {
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0', 'Content-Length': PIXEL.length });
  res.end(PIXEL);
  const t = readTrackingToken(req.params.token);
  if (t && isDbReady()) recordOpen(t).catch((err) => console.warn('[track] open:', err.message));
});

router.get('/c/:token', async (req, res) => {
  const url = String(req.query.u || '');
  const t = readTrackingToken(req.params.token);
  // Only redirect to URLs we signed, so this can't be used as an open redirect.
  if (!t || !/^https?:\/\//i.test(url) || !verifySignedUrl(req.params.token, url, req.query.s)) {
    return res.status(400).type('text/plain').send('This link is not valid.');
  }
  res.redirect(302, url);
  if (isDbReady()) recordClick(t, url, String(req.query.l || '')).catch((err) => console.warn('[track] click:', err.message));
});

export default router;
