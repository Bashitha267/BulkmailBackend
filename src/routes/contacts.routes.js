import { Router } from 'express';
import { db, saveStore } from '../data/store.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', (_req, res) => {
  res.json({ success: true, contacts: db.contacts });
});

router.post('/', (req, res) => {
  const { name, email, city, plan, groups, consent } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'Name and email are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (db.contacts.some((c) => c.email.toLowerCase() === normalizedEmail)) {
    return res.status(409).json({ success: false, message: 'A contact with this email already exists.' });
  }

  const parts = name.trim().split(/\s+/);
  const initials =
    parts.length >= 2
      ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
      : name.trim().slice(0, 2).toUpperCase();

  const newContact = {
    id: `${normalizedEmail.replace(/[^a-z0-9]/g, '-')}-${Date.now()}`,
    name: name.trim(),
    initials,
    email: email.trim(),
    city: (city || 'Colombo').trim(),
    plan: plan || 'Free',
    groups: Array.isArray(groups) && groups.length > 0 ? groups : ['Newsletter'],
    consent: consent || 'Manual entry',
    consentDate: 'Today',
    lastActivity: 'Added just now',
    status: 'Subscribed',
    stats: { received: 0, opened: 0, clicked: 0 },
    activity: [
      {
        id: Date.now(),
        type: 'group',
        title: `Added to ${(groups || ['Newsletter']).join(', ')}`,
        time: 'Just now',
        category: 'Changes',
      },
    ],
  };

  db.contacts.unshift(newContact);
  saveStore();

  return res.status(201).json({ success: true, contact: newContact });
});

router.post('/import', (req, res) => {
  const { contacts: incoming } = req.body || {};
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return res.status(400).json({ success: false, message: 'No contacts provided for import.' });
  }

  const existingEmails = new Set(db.contacts.map((c) => c.email.toLowerCase()));
  const inserted = [];

  for (const item of incoming) {
    if (!item.email) continue;
    const lower = item.email.trim().toLowerCase();
    if (existingEmails.has(lower)) continue;
    existingEmails.add(lower);

    const fullName = (item.name || item.email.split('@')[0]).trim();
    const parts = fullName.split(/\s+/);
    const initials =
      parts.length >= 2
        ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
        : fullName.slice(0, 2).toUpperCase();

    const contact = {
      id: `${lower.replace(/[^a-z0-9]/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: fullName,
      initials,
      email: item.email.trim(),
      city: item.city || '—',
      plan: item.plan || 'Free',
      groups: Array.isArray(item.groups) && item.groups.length > 0 ? item.groups : ['Newsletter'],
      consent: item.consent || 'CSV import',
      consentDate: item.consentDate || 'Today',
      lastActivity: 'Imported just now',
      status: 'Subscribed',
      stats: { received: 0, opened: 0, clicked: 0 },
      activity: [
        {
          id: Date.now(),
          type: 'group',
          title: 'Imported via CSV',
          time: 'Just now',
          category: 'Changes',
        },
      ],
    };
    inserted.push(contact);
  }

  db.contacts = [...inserted, ...db.contacts];
  saveStore();

  return res.status(201).json({
    success: true,
    importedCount: inserted.length,
    contacts: inserted,
  });
});

router.patch('/:id', (req, res) => {
  const { id } = req.params;
  const contact = db.contacts.find((c) => c.id === id);
  if (!contact) {
    return res.status(404).json({ success: false, message: 'Contact not found.' });
  }

  const allowed = ['name', 'email', 'city', 'plan', 'groups', 'status'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      contact[key] = req.body[key];
    }
  }

  if (req.body.name) {
    const parts = req.body.name.trim().split(/\s+/);
    contact.initials =
      parts.length >= 2
        ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
        : req.body.name.trim().slice(0, 2).toUpperCase();
  }

  saveStore();
  return res.json({ success: true, contact });
});

export default router;
