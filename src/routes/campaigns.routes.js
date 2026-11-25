import { Router } from 'express';
import { db, saveStore } from '../data/store.js';
import { requireAuth } from '../middleware/auth.js';
import { sendEmail, isLiveSesConfigured } from '../services/ses.service.js';

const router = Router();
router.use(requireAuth);

function sanitizeCampaign(c) {
  const { queue: _queue, ...rest } = c;
  return rest;
}

router.get('/', (_req, res) => {
  res.json({
    success: true,
    campaigns: db.campaigns.map(sanitizeCampaign),
    sesMode: isLiveSesConfigured() ? 'live' : 'simulation',
  });
});

router.get('/:id', (req, res) => {
  const campaign = db.campaigns.find((c) => c.id === req.params.id);
  if (!campaign) {
    return res.status(404).json({ success: false, message: 'Campaign not found.' });
  }
  return res.json({
    success: true,
    campaign: sanitizeCampaign(campaign),
    sesMode: isLiveSesConfigured() ? 'live' : 'simulation',
  });
});

router.post('/', (req, res) => {
  const {
    title,
    subjectA,
    subjectB,
    abTest,
    previewText,
    fromName,
    fromEmail,
    replyTo,
    selectedGroups = ['Newsletter'],
    templateStrategy = 'same',
    selectedTemplateId = 'monthly-newsletter',
    groupTemplateMap = {},
    sendSchedule = 'now',
    scheduledDate,
  } = req.body || {};

  // Build deduplicated recipient queue from subscribed contacts in selected groups
  const seenEmails = new Set();
  const queue = [];

  for (const contact of db.contacts) {
    if (contact.status !== 'Subscribed') continue;
    const contactGroups = contact.groups || [];
    const matchedGroup = selectedGroups.find((g) => contactGroups.includes(g));
    if (!matchedGroup) continue;

    const lower = contact.email.toLowerCase();
    if (seenEmails.has(lower)) continue;
    seenEmails.add(lower);

    const assignedTemplateName =
      templateStrategy === 'custom_per_group'
        ? groupTemplateMap[matchedGroup] || 'Monthly newsletter'
        : undefined;

    queue.push({
      email: contact.email,
      name: contact.name,
      firstName: contact.name.split(' ')[0],
      city: contact.city,
      plan: contact.plan,
      templateId: templateStrategy === 'same' ? selectedTemplateId : undefined,
      templateName: assignedTemplateName,
      status: 'pending',
    });
  }

  const now = new Date();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const id = `${(title || 'campaign').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString().slice(-5)}`;
  const isSendNow = sendSchedule === 'now';

  const newCampaign = {
    id,
    month: monthNames[now.getMonth()],
    day: String(now.getDate()),
    title: title || subjectA || 'Untitled campaign',
    subtitle: `${selectedGroups.join(', ')} · ${queue.length} people`,
    description: isSendNow ? 'Queued for Amazon SES dispatch' : scheduledDate || 'Scheduled',
    status: isSendNow ? 'Sending' : 'Scheduled',
    subjectA: subjectA || 'Hello {{firstName}}',
    subjectB,
    abTest: Boolean(abTest),
    previewText: previewText || '',
    fromName: fromName || 'Acme Team',
    fromEmail: fromEmail || 'news@acme.example.com',
    replyTo: replyTo || 'support@acme.example.com',
    recipientsCount: queue.length,
    scheduledDate,
    progress: {
      sent: 0,
      total: queue.length,
      waiting: queue.length,
      percentage: 0,
    },
    stats: {
      delivered: 0,
      opened: 0,
      bounced: 0,
      failed: 0,
      complaints: 0,
      waiting: queue.length,
    },
    linkClicks: [
      { title: 'Primary CTA Link', url: 'example.com', clicks: 0 },
    ],
    problems: [],
    activity: [
      {
        id: Date.now(),
        title: isSendNow ? `Queued ${queue.length} recipients for Amazon SES cron` : `Scheduled for ${scheduledDate}`,
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        type: 'started',
      },
    ],
    queue,
  };

  db.campaigns.unshift(newCampaign);
  saveStore();

  return res.status(201).json({
    success: true,
    campaign: sanitizeCampaign(newCampaign),
  });
});

router.post('/send-test', async (req, res, next) => {
  try {
    const { emails, subject, previewText, fromName, fromEmail, templateId } = req.body || {};
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ success: false, message: 'Provide at least one test email.' });
    }

    const tpl = db.templates.find((t) => t.id === templateId) || db.templates[0];
    const results = [];

    for (const to of emails) {
      const result = await sendEmail({
        to,
        subject: `[TEST] ${(subject || tpl?.subject || 'Test Email').replace(/\{\{\s*firstName\s*\}\}/gi, 'Jane')}`,
        html: `<div style="font-family:sans-serif;padding:24px;"><h2>${(tpl?.heading || 'Hello Jane').replace(/\{\{\s*firstName\s*\}\}/gi, 'Jane')}</h2><p>${tpl?.body || previewText || ''}</p></div>`,
        text: tpl?.body || previewText || 'Test email',
        fromName,
        fromEmail,
      });
      results.push({ to, ...result });
    }

    return res.json({
      success: true,
      sentCount: results.length,
      simulated: results.every((r) => r.simulated),
      results,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/resume', (req, res) => {
  const campaign = db.campaigns.find((c) => c.id === req.params.id);
  if (!campaign) {
    return res.status(404).json({ success: false, message: 'Campaign not found.' });
  }

  if (!Array.isArray(campaign.queue) || campaign.queue.length === 0) {
    const waitingCount = campaign.progress?.waiting || 20;
    const demoBatchSize = Math.min(waitingCount, 40);
    campaign.queue = Array.from({ length: demoBatchSize }, (_, i) => ({
      email: `subscriber${i + 1}@example.com`,
      name: `Subscriber ${i + 1}`,
      firstName: `Subscriber`,
      city: 'Colombo',
      plan: 'Pro',
      templateId: 'monthly-newsletter',
      status: 'pending',
    }));
    if (campaign.progress) {
      campaign.progress.total = (campaign.progress.sent || 0) + demoBatchSize;
      campaign.progress.waiting = demoBatchSize;
    }
  }

  campaign.status = 'Sending';
  campaign.activity = [
    {
      id: Date.now(),
      title: 'Resumed by Admin',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      type: 'resumed',
    },
    ...(campaign.activity || []),
  ];
  saveStore();

  return res.json({ success: true, campaign: sanitizeCampaign(campaign) });
});

router.post('/:id/pause', (req, res) => {
  const campaign = db.campaigns.find((c) => c.id === req.params.id);
  if (!campaign) {
    return res.status(404).json({ success: false, message: 'Campaign not found.' });
  }

  campaign.status = 'Paused';
  campaign.activity = [
    {
      id: Date.now(),
      title: 'Paused by Admin',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      type: 'paused',
    },
    ...(campaign.activity || []),
  ];
  saveStore();

  return res.json({ success: true, campaign: sanitizeCampaign(campaign) });
});

router.post('/:id/cancel', (req, res) => {
  const campaign = db.campaigns.find((c) => c.id === req.params.id);
  if (!campaign) {
    return res.status(404).json({ success: false, message: 'Campaign not found.' });
  }

  campaign.status = 'Cancelled';
  if (Array.isArray(campaign.queue)) {
    campaign.queue.forEach((item) => {
      if (item.status === 'pending') item.status = 'cancelled';
    });
  }
  if (campaign.progress) campaign.progress.waiting = 0;
  if (campaign.stats) campaign.stats.waiting = 0;

  saveStore();
  return res.json({ success: true, campaign: sanitizeCampaign(campaign) });
});

export default router;
