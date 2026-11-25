import express, { Router } from 'express';
import { requireDb } from '../middleware/auth.js';
import { verifySnsMessage, confirmSubscription, handleSesEvent } from '../services/sns.service.js';

/** Amazon SNS posts SES bounce, complaint and delivery notifications here. */
const router = Router();

router.post('/ses', express.text({ type: '*/*', limit: '256kb' }), requireDb, async (req, res) => {
  let msg;
  try {
    msg = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ success: false, message: 'Body is not JSON.' });
  }
  try {
    const problem = await verifySnsMessage(msg);
    if (problem) {
      console.warn(`[sns] Rejected: ${problem}`);
      return res.status(403).json({ success: false, message: problem });
    }
    if (msg.Type === 'SubscriptionConfirmation') {
      await confirmSubscription(msg);
      console.log(`[sns] Confirmed subscription to ${msg.TopicArn}`);
      return res.json({ success: true, confirmed: true });
    }
    if (msg.Type === 'Notification') {
      const result = await handleSesEvent(JSON.parse(msg.Message));
      return res.json({ success: true, ...result });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[sns] Failed:', err.message);
    // 500 makes SNS retry later, which is what we want for a temporary DB problem.
    return res.status(500).json({ success: false });
  }
});

export default router;
