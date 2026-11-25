import { Router } from 'express';
import { db, saveStore } from '../data/store.js';
import { requireAuth } from '../middleware/auth.js';
import { isLiveSesConfigured } from '../services/ses.service.js';

const router = Router();
router.use(requireAuth);

router.get('/bootstrap', (_req, res) => {
  res.json({
    success: true,
    sesMode: isLiveSesConfigured() ? 'live' : 'simulation',
    contacts: db.contacts,
    campaigns: db.campaigns.map(({ queue: _q, ...rest }) => rest),
    templates: db.templates,
    groups: db.groups,
    segments: db.segments,
    automations: db.automations,
    settings: db.settings,
  });
});

router.post('/groups', (req, res) => {
  const { name, description, defaultTemplate, contactIds = [] } = req.body || {};
  if (!name) {
    return res.status(400).json({ success: false, message: 'Group name is required.' });
  }

  const newGroup = {
    id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString().slice(-4)}`,
    name: name.trim(),
    description: (description || '').trim(),
    defaultTemplate: defaultTemplate || 'Monthly newsletter',
    total: contactIds.length,
    canReceive: contactIds.length,
  };

  if (contactIds.length > 0) {
    db.contacts.forEach((c) => {
      if (contactIds.includes(c.id) && !c.groups.includes(newGroup.name)) {
        c.groups.push(newGroup.name);
      }
    });
  }

  db.groups.unshift(newGroup);
  saveStore();

  return res.status(201).json({ success: true, group: newGroup });
});

router.patch('/automations/:id/toggle', (req, res) => {
  const auto = db.automations.find((a) => a.id === req.params.id);
  if (!auto) {
    return res.status(404).json({ success: false, message: 'Automation not found.' });
  }
  auto.active = !auto.active;
  saveStore();
  return res.json({ success: true, automation: auto });
});

router.put('/settings', (req, res) => {
  const { ses, compliance } = req.body || {};
  if (ses) {
    db.settings.ses = { ...db.settings.ses, ...ses };
  }
  if (compliance) {
    db.settings.compliance = { ...db.settings.compliance, ...compliance };
  }
  saveStore();
  return res.json({ success: true, settings: db.settings });
});

router.post('/settings/fields', (req, res) => {
  const { name, type } = req.body || {};
  if (!name) {
    return res.status(400).json({ success: false, message: 'Field name is required.' });
  }
  const tag = `{{${name.toLowerCase().replace(/\s+/g, '')}}}`;
  const field = {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name: name.trim(),
    type: type || 'Text',
    tag,
    filled: 0,
  };
  db.settings.fields.push(field);
  saveStore();
  return res.status(201).json({ success: true, field });
});

router.delete('/settings/fields/:id', (req, res) => {
  db.settings.fields = db.settings.fields.filter(
    (f) => f.id !== req.params.id && f.name !== req.params.id
  );
  saveStore();
  return res.json({ success: true, fields: db.settings.fields });
});

router.post('/settings/senders', (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required.' });
  }
  const sender = { email: email.trim(), isDefault: false, verified: true };
  db.settings.senders.push(sender);
  saveStore();
  return res.status(201).json({ success: true, sender });
});

router.post('/settings/domains', (req, res) => {
  const { name } = req.body || {};
  if (!name) {
    return res.status(400).json({ success: false, message: 'Domain name is required.' });
  }
  const domain = { name: name.trim(), verifiedRecords: 1, totalRecords: 3 };
  db.settings.domains.push(domain);
  saveStore();
  return res.status(201).json({ success: true, domain });
});

router.post('/settings/team', (req, res) => {
  const { name, email, role } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ success: false, message: 'Name and email are required.' });
  }
  const parts = name.trim().split(/\s+/);
  const avatar =
    parts.length >= 2
      ? `${parts[0][0]}${parts[1][0]}`.toUpperCase()
      : name.trim().slice(0, 2).toUpperCase();
  const member = { name: name.trim(), email: email.trim(), role: role || 'Editor', avatar };
  db.settings.team.push(member);
  saveStore();
  return res.status(201).json({ success: true, member });
});

export default router;
