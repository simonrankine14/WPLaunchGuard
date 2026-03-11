# Week 5 Billing + Stripe Checkout

Week 5 adds plan-aware billing to the Baseline API and a Billing page in the WordPress plugin.

## What is new

1. Tenant billing table (`tenant_billing`) tracks plan + Stripe linkage.
2. Scan creation now enforces monthly scan limits by plan.
3. New API endpoints:
   - `GET /v1/sites/{siteId}/billing`
   - `POST /v1/sites/{siteId}/billing/checkout-session`
   - `POST /v1/stripe/webhook`
4. WordPress plugin adds `Baseline -> Billing` screen with plan selection and checkout start.
5. Stripe webhook updates billing state after checkout/subscription events.

## Step-by-step setup

1. Apply D1 migration:

```bash
npx wrangler d1 migrations apply baseline-db-dev --remote --config services/api-worker/wrangler.toml
```

2. Add Stripe plan price IDs to Worker vars in `services/api-worker/wrangler.toml`:

- `STRIPE_PRICE_ID_STARTER`
- `STRIPE_PRICE_ID_GROWTH`
- `STRIPE_PRICE_ID_AGENCY`

3. Set Worker secrets:

```bash
npx wrangler secret put STRIPE_SECRET_KEY --config services/api-worker/wrangler.toml
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config services/api-worker/wrangler.toml
```

4. Deploy worker:

```bash
npm run api:deploy
```

5. In Stripe Dashboard (test mode), set webhook endpoint to:

- `https://<your-worker-subdomain>.workers.dev/v1/stripe/webhook`

Subscribe at minimum to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

6. Re-copy webhook signing secret from Stripe into Worker secret `STRIPE_WEBHOOK_SECRET` if Stripe rotated it.

7. In WordPress admin:

- Go to `Baseline -> Billing`
- Choose a plan
- Complete checkout in Stripe test mode
- Return to Billing page and confirm status/plan updates

## Verify

```bash
npm run week5:verify
```

## Important files

- `services/api-worker/migrations/0002_billing.sql`
- `services/api-worker/src/index.js`
- `wordpress-plugin/baseline/includes/class-baseline-admin.php`
- `wordpress-plugin/baseline/assets/css/admin.css`
