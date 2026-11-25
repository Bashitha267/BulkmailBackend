/** Default values for app_settings rows. Merged over whatever is stored. */
export const WARMUP_SCHEDULE = [50, 100, 200, 400, 600, 1000, 1500, 2000, 3000, 4000, 5000, 6500, 8000, 10000];

export const DEFAULT_SETTINGS = {
  general: {
    teamName: 'Acme Team',
    fromName: '',
    replyTo: '',
  },
  ses: {
    sendRate: 10,
    retries: 3,
    dailyLimit: 1000,
    simulation: false,
    warmup: { enabled: true, startedAt: null },
  },
  compliance: {
    address: '',
    oneClickUnsubscribe: true,
    doubleOptIn: true,
    preferencePage: true,
    trackOpens: true,
    trackClicks: true,
  },
  fields: [
    { key: 'city', name: 'City', type: 'text', builtIn: true },
    { key: 'plan', name: 'Plan', type: 'choice', options: ['Free', 'Pro', 'Business'], builtIn: true },
  ],
  domains: [],
  senders: [],
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

/** Email topics a subscriber can opt in or out of on the preference page. */
export const TOPICS = [
  { key: 'newsletter', name: 'Monthly newsletter', description: 'Product news, once a month' },
  { key: 'offers', name: 'Offers and promotions', description: 'A few times a year, like Black Friday' },
  { key: 'account', name: 'Account and order updates', description: 'Receipts and important changes' },
];

export const CONTACT_STATUSES = ['Subscribed', 'Unsubscribed', 'Bounced', 'Complained'];

export function defaultBlocks(tpl = {}) {
  return [
    { id: 'b1', type: 'heading', text: tpl.heading || 'Hello {{firstName}}' },
    { id: 'b2', type: 'text', text: tpl.body || 'Write your message here.' },
    {
      id: 'b3',
      type: 'button',
      label: tpl.ctaLabel || 'Read more',
      url: tpl.ctaUrl || 'https://example.com',
      color: tpl.ctaColor || '#111111',
      corners: 'rounded',
    },
  ];
}
