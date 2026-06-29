import Stripe from 'stripe';
import config from '../../config/default.js';
import { getDb } from '../../data/db.js';
import { logger } from './index.js';

export async function handleStripeWebhook(req) {
  const sig = req.headers['stripe-signature'];
  const stripe = new Stripe(config.stripe.secretKey);
  const event = stripe.webhooks.constructEvent(req.body, sig, config.stripe.webhookSecret);

  const db = getDb();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const customerId = session.customer;
      const githubUserId = session.metadata?.github_user_id;
      const subscriptionId = session.subscription;

      if (githubUserId) {
        db.prepare(`UPDATE accounts SET
          stripe_customer_id = ?, subscription_id = ?, tier = 'paid',
          prs_limit = 999999, billing_period_start = datetime('now'),
          billing_period_end = datetime('now', '+1 month'), updated_at = datetime('now')
          WHERE github_user_id = ?`)
          .run(customerId, subscriptionId, githubUserId);
        logger.info({ githubUserId, customerId }, 'Subscription activated');
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const customerId = sub.customer;
      const account = db.prepare(`SELECT github_user_id FROM accounts WHERE stripe_customer_id = ?`).get(customerId);
      if (account) {
        db.prepare(`UPDATE accounts SET tier = 'free', prs_limit = 5, subscription_id = NULL,
          prs_used = 0, updated_at = datetime('now') WHERE github_user_id = ?`)
          .run(account.github_user_id);
        logger.info({ githubUserId: account.github_user_id }, 'Subscription cancelled');
      }
      break;
    }
  }

  return { received: true };
}
