import Stripe from 'stripe';
import config from '../../config/default.js';
import { getDb } from '../../data/db.js';
import { logger } from '../../api/webhooks/index.js';

export function getBilling() {
  return new Stripe(config.stripe.secretKey);
}

export function checkLimit(installationId) {
  const db = getDb();
  const repo = db.prepare(`SELECT owner, name FROM repos WHERE installation_id = ? LIMIT 1`).get(installationId);
  if (!repo) return { allowed: false, reason: 'No repo found' };

  const account = db.prepare(`
    SELECT a.* FROM accounts a
    JOIN repos r ON r.owner = a.login
    WHERE r.installation_id = ?
  `).get(installationId);

  if (!account) {
    const install = db.prepare(`SELECT account_login FROM installations WHERE id = ?`).get(installationId);
    if (install) {
      db.prepare(`INSERT OR IGNORE INTO accounts (github_user_id, login, tier, prs_limit)
        VALUES (?, ?, 'free', ?)`)
        .run(installationId, install.account_login, config.pricing.freeMonthlyPRs);
    }
    return { allowed: true, remaining: config.pricing.freeMonthlyPRs };
  }

  const periodEnd = account.billing_period_end ? new Date(account.billing_period_end) : null;
  if (periodEnd && periodEnd < new Date()) {
    db.prepare(`UPDATE accounts SET prs_used = 0, billing_period_start = datetime('now'),
      billing_period_end = datetime('now', '+1 month'), updated_at = datetime('now') WHERE id = ?`)
      .run(account.id);
    account.prs_used = 0;
  }

  const remaining = account.prs_limit - account.prs_used;
  if (remaining <= 0) {
    return { allowed: false, reason: 'PR limit reached', remaining: 0, tier: account.tier };
  }

  return { allowed: true, remaining, tier: account.tier };
}

export function incrementUsage(installationId) {
  const db = getDb();
  db.prepare(`UPDATE accounts SET prs_used = prs_used + 1, updated_at = datetime('now')
    WHERE github_user_id = (SELECT account_login FROM installations WHERE id = ?)`).run(installationId);
}

export function createCheckoutSession(githubUserId, successUrl, cancelUrl) {
  const stripe = getBilling();
  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: config.stripe.priceId, quantity: 1 }],
    metadata: { github_user_id: String(githubUserId) },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

export function createPortalSession(stripeCustomerId) {
  const stripe = getBilling();
  return stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: 'https://autopr.dev/dashboard',
  });
}
