import crypto from 'node:crypto';
import { query, one } from '../config/db.js';
import { recordContactEvent } from './contacts.service.js';
import { markCampaignDirty } from './worker.service.js';

async function campaignTitle(id) {
  const row = await one('SELECT title FROM campaigns WHERE id = ?', [id]);
  return row?.title || 'a campaign';
}

export async function recordOpen({ kind, id }) {
  if (kind === 'a') {
    await query('UPDATE automation_sends SET opened_at = UTC_TIMESTAMP() WHERE id = ? AND opened_at IS NULL', [id]);
    return;
  }
  const res = await query('UPDATE campaign_recipients SET opened_at = UTC_TIMESTAMP() WHERE id = ? AND opened_at IS NULL', [id]);
  if (!res.affectedRows) return;
  const r = await one('SELECT campaign_id, contact_id FROM campaign_recipients WHERE id = ?', [id]);
  markCampaignDirty(r.campaign_id);
  if (r.contact_id) {
    await query('UPDATE contacts SET open_count = open_count + 1 WHERE id = ?', [r.contact_id]);
    await recordContactEvent(r.contact_id, {
      type: 'opened',
      title: `Opened ${await campaignTitle(r.campaign_id)}`,
      campaignId: r.campaign_id,
      activity: 'Opened',
    });
  }
}

export async function recordClick({ kind, id }, url, label) {
  if (kind === 'a') {
    await query(
      'UPDATE automation_sends SET clicked_at = COALESCE(clicked_at, UTC_TIMESTAMP()), opened_at = COALESCE(opened_at, UTC_TIMESTAMP()) WHERE id = ?',
      [id]
    );
    return;
  }
  const r = await one('SELECT campaign_id, contact_id, clicked_at FROM campaign_recipients WHERE id = ?', [id]);
  if (!r) return;
  await query(
    'UPDATE campaign_recipients SET clicked_at = COALESCE(clicked_at, UTC_TIMESTAMP()), opened_at = COALESCE(opened_at, UTC_TIMESTAMP()) WHERE id = ?',
    [id]
  );
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  await query(
    `INSERT INTO link_clicks (campaign_id, url_hash, url, label, clicks) VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE clicks = clicks + 1`,
    [r.campaign_id, hash, url.slice(0, 1000), String(label || '').slice(0, 255)]
  );
  markCampaignDirty(r.campaign_id);
  if (r.contact_id && !r.clicked_at) {
    await query('UPDATE contacts SET click_count = click_count + 1 WHERE id = ?', [r.contact_id]);
    await recordContactEvent(r.contact_id, {
      type: 'clicked',
      title: `Clicked “${label || 'a link'}” in ${await campaignTitle(r.campaign_id)}`,
      campaignId: r.campaign_id,
      activity: 'Clicked',
    });
  }
}
