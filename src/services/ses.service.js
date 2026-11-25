import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { env } from '../config/env.js';

let sesClient = null;

function getSesClient() {
  if (!sesClient && env.aws.accessKeyId && env.aws.secretAccessKey) {
    sesClient = new SESClient({
      region: env.aws.region,
      credentials: {
        accessKeyId: env.aws.accessKeyId,
        secretAccessKey: env.aws.secretAccessKey,
      },
    });
  }
  return sesClient;
}

export function isLiveSesConfigured() {
  return Boolean(!env.aws.simulationMode && env.aws.accessKeyId && env.aws.secretAccessKey);
}

/**
 * Sends a single email via Amazon SES or Simulation Mode.
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  fromName = env.aws.fromName,
  fromEmail = env.aws.fromEmail,
  replyTo,
}) {
  const source = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  if (!isLiveSesConfigured()) {
    // Simulation mode: realistic fast dispatch without hitting AWS
    await new Promise((r) => setTimeout(r, 15));
    return {
      simulated: true,
      messageId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  const client = getSesClient();
  const command = new SendEmailCommand({
    Source: source,
    Destination: {
      ToAddresses: [to],
    },
    ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8',
      },
      Body: {
        Html: {
          Data: html || `<p>${text || ''}</p>`,
          Charset: 'UTF-8',
        },
        ...(text
          ? {
              Text: {
                Data: text,
                Charset: 'UTF-8',
              },
            }
          : {}),
      },
    },
  });

  const result = await client.send(command);
  return {
    simulated: false,
    messageId: result.MessageId,
  };
}
