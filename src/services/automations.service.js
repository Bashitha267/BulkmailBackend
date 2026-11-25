import { query, one, parseJson } from '../config/db.js';
import { env } from '../config/env.js';
import { randomHex } from '../lib/util.js';
import { defaultBlocks } from '../lib/defaults.js';
import { sendEmail } from './ses.service.js';
import { renderEmail, trackingToken } from './render.service.js';
import { recordContactEvent } from './contacts.service.js';

/**
 * Steps: { type: 'send', templateId, subject }
 *        { type: 'wait', days }
 *        { type: 'condition', check: 'not_clicked_previous' | 'not_opened_previous' }
 * A failed condition ends the run for that person.
 */
export function serializeAutomation(row, stats = null) {
  return {
    id: row.id,
    name: row.name,
    triggerType: row.trigger_type,
    triggerGroupId: row.trigger_group_id,
    steps: parseJson(row.steps_json, []) || [],
    active: Boolean(row.active),
    activatedAt: row.activated_at,
    createdAt: row.created_at,
    stats,
  };
}

export async function automationStats(id) {
  const [runs] = await query(
    `SELECT COUNT(*) AS started, SUM(status = 'active') AS in_progress, MAX(IF(status='active', step_index, NULL)) AS step
     FROM automation_runs WHERE automation_id = ?`,
    [id]
  );
  const [first] = await query(
    `SELECT COUNT(*) AS sent, SUM(opened_at IS NOT NULL) AS opened, SUM(clicked_at IS NOT NULL) AS clicked
     FROM automation_sends WHERE automation_id = ? AND step_index = 0`,
    [id]
  );
  const sent = Number(first.sent) || 0;
  return {
    started: Number(runs.started) || 0,
    inProgress: Number(runs.in_progress) || 0,
    waitingStep: runs.step === null ? null : Number(runs.step) + 1,
    firstEmailSent: sent,
    firstEmailOpened: Number(first.opened) || 0,
    openRate: sent ? Number(first.opened) / sent : 0,
  };
}

/** Called whenever contacts join a group. Only active automations enrol people. */
export async function enrollOnGroupJoin(contactIds, groupIds) {
  if (!contactIds.length || !groupIds.length) return 0;
  const autos = await query(
    "SELECT id FROM automations WHERE active = 1 AND trigger_type = 'group_join' AND trigger_group_id IN (?)",
    [groupIds]
  );
  let enrolled = 0;
  for (const a of autos) {
    const res = await query(
      `INSERT IGNORE INTO automation_runs (automation_id, contact_id, step_index, status, next_run_at)
       SELECT ?, c.id, 0, 'active', UTC_TIMESTAMP() FROM contacts c WHERE c.id IN (?) AND c.status = 'Subscribed'`,
      [a.id, contactIds]
    );
    enrolled += res.affectedRows;
  }
  return enrolled;
}

async function runStep(run, automation, contact, settings) {
  const steps = parseJson(automation.steps_json, []) || [];
  let index = run.step_index;
  let sent = 0;

  while (index < steps.length) {
    const step = steps[index];
    if (contact.status !== 'Subscribed') return { status: 'exited', index, sent };

    if (step.type === 'wait') {
      const daysToWait = Math.max(0, Number(step.days) || 0);
      return { status: 'active', index: index + 1, nextRunAt: new Date(Date.now() + daysToWait * 86400000), sent };
    }

    if (step.type === 'condition') {
      const [prev] = await query(
        'SELECT opened_at, clicked_at FROM automation_sends WHERE run_id = ? ORDER BY step_index DESC, id DESC LIMIT 1',
        [run.id]
      );
      const passed = step.check === 'not_opened_previous' ? !prev?.opened_at : !prev?.clicked_at;
      if (!passed) return { status: 'done', index, sent };
      index += 1;
      continue;
    }

    if (step.type === 'send') {
      const tpl = step.templateId ? await one('SELECT * FROM templates WHERE id = ?', [step.templateId]) : null;
      if (!tpl) return { status: 'error', index, sent, error: 'The email for this step has no template.' };
      const ins = await query(
        'INSERT INTO automation_sends (run_id, automation_id, contact_id, step_index, template_id, email) VALUES (?, ?, ?, ?, ?, ?)',
        [run.id, automation.id, contact.id, index, tpl.id, contact.email]
      );
      const blocks = parseJson(tpl.blocks_json, null) || defaultBlocks({ heading: tpl.heading, body: tpl.body, ctaLabel: tpl.cta_label, ctaUrl: tpl.cta_url });
      const email = renderEmail({
        blocks,
        subject: step.subject || tpl.subject,
        previewText: tpl.preview_text,
        contact: {
          name: contact.name,
          firstName: contact.first_name,
          lastName: contact.last_name,
          email: contact.email,
          city: contact.city,
          plan: contact.plan,
          customFields: parseJson(contact.custom_fields_json, {}),
        },
        settings,
        unsubToken: contact.unsub_token,
        trackToken: trackingToken('a', ins.insertId),
      });
      const defaultSender = settings.senders.find((s) => s.isDefault) || settings.senders[0];
      try {
        const res = await sendEmail({
          settings,
          to: contact.email,
          fromEmail: defaultSender?.email || env.aws.fromEmail,
          fromName: settings.general.fromName || env.aws.fromName || settings.general.teamName,
          replyTo: settings.general.replyTo,
          ...email,
        });
        await query('UPDATE automation_sends SET message_id = ? WHERE id = ?', [res.messageId, ins.insertId]);
        await query('UPDATE contacts SET sent_count = sent_count + 1 WHERE id = ?', [contact.id]);
        await recordContactEvent(contact.id, { type: 'delivered', title: `Sent ${tpl.name} (${automation.name})` });
        sent += 1;
      } catch (err) {
        await query('DELETE FROM automation_sends WHERE id = ?', [ins.insertId]);
        // Try again on the next pass rather than skipping the email.
        return { status: 'active', index, nextRunAt: new Date(Date.now() + 15 * 60000), sent, error: err.message };
      }
      index += 1;
      continue;
    }
    index += 1; // unknown step type: skip
  }
  return { status: 'done', index, sent };
}

/** Runs due automation steps, sending at most `budget` emails. */
export async function processAutomations(settings, budget) {
  if (budget <= 0) return 0;
  const token = randomHex(8);
  const claimed = await query(
    `UPDATE automation_runs SET claim_token = ?
     WHERE status = 'active' AND claim_token IS NULL AND next_run_at <= UTC_TIMESTAMP()
       AND automation_id IN (SELECT id FROM automations WHERE active = 1)
     ORDER BY next_run_at LIMIT ?`,
    [token, Math.min(budget, 25)]
  );
  if (!claimed.affectedRows) return 0;
  const runs = await query('SELECT * FROM automation_runs WHERE claim_token = ?', [token]);
  let sent = 0;
  for (const run of runs) {
    const automation = await one('SELECT * FROM automations WHERE id = ?', [run.automation_id]);
    const contact = await one('SELECT * FROM contacts WHERE id = ?', [run.contact_id]);
    if (!automation || !contact) {
      await query("UPDATE automation_runs SET status = 'exited', claim_token = NULL WHERE id = ?", [run.id]);
      continue;
    }
    const result = await runStep(run, automation, contact, settings);
    sent += result.sent;
    await query(
      'UPDATE automation_runs SET status = ?, step_index = ?, next_run_at = ?, claim_token = NULL WHERE id = ?',
      [result.status, result.index, result.nextRunAt || new Date(), run.id]
    );
    if (result.error) console.warn(`[automation] ${automation.name}: ${result.error}`);
  }
  return sent;
}
