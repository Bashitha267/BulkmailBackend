import cron from 'node-cron';
import { db, saveStore } from '../data/store.js';
import { env } from '../config/env.js';
import { sendEmail } from './ses.service.js';

let isProcessing = false;
let cronTask = null;

function interpolate(text, vars) {
  if (!text) return '';
  return text
    .replace(/\{\{\s*firstName\s*\}\}/gi, vars.firstName || 'there')
    .replace(/\{\{\s*city\s*\}\}/gi, vars.city || '')
    .replace(/\{\{\s*plan\s*\}\}/gi, vars.plan || 'Free');
}

function buildHtmlFromTemplate(tpl, vars, businessAddress) {
  if (!tpl) {
    return `<div style="font-family:sans-serif;padding:24px;"><h2>Hello ${vars.firstName}</h2><p>Update from Acme Team</p></div>`;
  }

  if (Array.isArray(tpl.blocks) && tpl.blocks.length > 0) {
    const renderedBlocks = tpl.blocks
      .map((b) => {
        if (b.type === 'heading') {
          return `<h1 style="font-size:24px;font-weight:bold;color:#111827;margin:0 0 16px;">${interpolate(b.content, vars)}</h1>`;
        }
        if (b.type === 'text') {
          return `<p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0 0 16px;">${interpolate(b.content, vars)}</p>`;
        }
        if (b.type === 'button') {
          return `<div style="margin:20px 0;"><a href="${b.link}" style="display:inline-block;background:${b.color || '#111111'};color:#ffffff;padding:12px 24px;border-radius:12px;font-weight:bold;font-size:14px;text-decoration:none;">${b.label}</a></div>`;
        }
        if (b.type === 'image') {
          return `<div style="margin:20px 0;"><img src="${b.url}" alt="${b.alt || ''}" style="max-width:100%;border-radius:12px;display:block;" /></div>`;
        }
        if (b.type === 'divider') {
          return `<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />`;
        }
        return '';
      })
      .join('');

    return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f4f5f7;padding:24px;"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;">${renderedBlocks}<hr style="border:none;border-top:1px solid #f3f4f6;margin:24px 0;"/><p style="font-size:11px;color:#9ca3af;text-align:center;">${businessAddress}</p></div></body></html>`;
  }

  const heading = interpolate(tpl.heading || 'Hello {{firstName}}', vars);
  const body = interpolate(tpl.body || '', vars);
  const ctaLabel = tpl.ctaLabel || 'Learn more';
  const ctaUrl = tpl.ctaUrl || 'https://example.com';
  const ctaColor = tpl.ctaColor || '#111111';

  return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f4f5f7;padding:24px;"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;"><h1 style="font-size:22px;color:#111827;margin:0 0 12px;">${heading}</h1><p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0 0 20px;">${body}</p><a href="${ctaUrl}" style="display:inline-block;background:${ctaColor};color:#ffffff;padding:12px 24px;border-radius:12px;font-weight:bold;font-size:14px;text-decoration:none;">${ctaLabel}</a><hr style="border:none;border-top:1px solid #f3f4f6;margin:24px 0;"/><p style="font-size:11px;color:#9ca3af;text-align:center;">${businessAddress}</p></div></body></html>`;
}

export async function processEmailQueueTick() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const activeCampaigns = db.campaigns.filter((c) => c.status === 'Sending');
    if (activeCampaigns.length === 0) return;

    const batchSize = Number(db.settings?.ses?.sendRate) || env.aws.batchSize || 10;
    const businessAddress = db.settings?.compliance?.address || 'Acme Team';
    let storeDirty = false;

    for (const campaign of activeCampaigns) {
      if (!Array.isArray(campaign.queue)) {
        campaign.queue = [];
      }

      const pendingItems = campaign.queue.filter((item) => item.status === 'pending');
      if (pendingItems.length === 0) {
        campaign.status = 'Completed';
        if (campaign.progress) {
          campaign.progress.waiting = 0;
          campaign.progress.percentage = 100;
        }
        campaign.activity = [
          {
            id: Date.now(),
            title: 'Campaign completed',
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            type: 'completed',
          },
          ...(campaign.activity || []),
        ];
        storeDirty = true;
        continue;
      }

      const batch = pendingItems.slice(0, batchSize);

      for (const item of batch) {
        // Re-check status in case campaign was paused mid-tick
        if (campaign.status !== 'Sending') break;

        const tpl =
          db.templates.find((t) => t.id === item.templateId || t.name === item.templateName) ||
          db.templates[0];

        const vars = {
          firstName: item.firstName || item.name?.split(' ')[0] || 'there',
          city: item.city || '',
          plan: item.plan || 'Free',
        };

        const subject = interpolate(campaign.subjectA || campaign.subject || tpl?.subject || campaign.title, vars);
        const html = buildHtmlFromTemplate(tpl, vars, businessAddress);
        const text = `${interpolate(tpl?.heading || '', vars)}\n\n${interpolate(tpl?.body || '', vars)}`;

        try {
          await sendEmail({
            to: item.email,
            subject,
            html,
            text,
            fromName: campaign.fromName || db.settings?.ses?.fromName || env.aws.fromName,
            fromEmail: campaign.fromEmail || env.aws.fromEmail,
            replyTo: campaign.replyTo,
          });

          item.status = 'sent';
          item.sentAt = new Date().toISOString();

          if (!campaign.progress) {
            campaign.progress = { sent: 0, total: campaign.queue.length, waiting: campaign.queue.length, percentage: 0 };
          }
          if (!campaign.stats) {
            campaign.stats = { delivered: 0, opened: 0, bounced: 0, failed: 0, complaints: 0, waiting: campaign.queue.length };
          }

          campaign.progress.sent += 1;
          campaign.progress.waiting = Math.max(0, campaign.progress.total - campaign.progress.sent);
          campaign.progress.percentage = Number(
            ((campaign.progress.sent / Math.max(1, campaign.progress.total)) * 100).toFixed(1)
          );

          campaign.stats.delivered += 1;
          campaign.stats.waiting = campaign.progress.waiting;
        } catch (err) {
          item.status = 'failed';
          item.error = err.message;

          if (!campaign.stats) {
            campaign.stats = { delivered: 0, opened: 0, bounced: 0, failed: 0, complaints: 0, waiting: 0 };
          }
          campaign.stats.failed += 1;
          campaign.progress.waiting = Math.max(0, campaign.progress.waiting - 1);
          campaign.stats.waiting = campaign.progress.waiting;

          campaign.problems = [
            {
              recipient: item.name || item.email,
              email: item.email,
              reason: `! Failed · ${err.message}`,
              action: 'Retry',
            },
            ...(campaign.problems || []),
          ];
        }

        storeDirty = true;
      }

      const remainingAfterBatch = campaign.queue.filter((item) => item.status === 'pending').length;
      if (remainingAfterBatch === 0 && campaign.status === 'Sending') {
        campaign.status = 'Completed';
        campaign.progress.waiting = 0;
        campaign.progress.percentage = 100;
        campaign.stats.waiting = 0;
        campaign.activity = [
          {
            id: Date.now(),
            title: `Finished sending to ${campaign.progress.total} recipients`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            type: 'completed',
          },
          ...(campaign.activity || []),
        ];
        storeDirty = true;
      }
    }

    if (storeDirty) {
      saveStore();
    }
  } finally {
    isProcessing = false;
  }
}

export function startEmailCron() {
  if (cronTask) return cronTask;
  // Runs every 2 seconds to deliver queued batches smoothly within SES rate limits
  cronTask = cron.schedule('*/2 * * * * *', () => {
    processEmailQueueTick().catch((err) => {
      console.error('[cron] Queue worker error:', err);
    });
  });
  console.log('[bulkemail-backend] Cron email queue worker started (every 2s)');
  return cronTask;
}

export function stopEmailCron() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}
