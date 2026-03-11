# Week 0 Setup Runbook (Accounts + Secrets)

This runbook gets you from zero to "ready for Week 1 build work."

## End State

By the end of Week 0, you will have:

1. Cloudflare account and API token with Workers/D1/R2/Queues access.
2. GitHub repo with Actions enabled and secrets configured.
3. Stripe test-mode products, prices, and webhook secret.
4. Local `.env.week0.local` file populated.
5. Passing local verification via `npm run week0:verify`.

## 1) Local tools

Run:

```bash
node -v
npm -v
git --version
```

Optional (can be done later in Week 1):

```bash
gh --version
wrangler --version
```

If you do not have Homebrew/global npm access, skip global installs for now.
You can still complete Week 0 and install CLI tools later when needed.

If you want local-only Wrangler without global install:

```bash
npx wrangler --version
```

## 2) Prepare local env file

From repo root:

```bash
cp .env.week0.example .env.week0.local
```

Open `.env.week0.local` and leave it open while you complete setup.

## 3) Cloudflare setup

In Cloudflare dashboard:

1. Create/select account.
2. Enable Workers & Pages.
3. Enable D1.
4. Enable R2.
5. Enable Queues.

Create API token:

1. `My Profile -> API Tokens -> Create Token -> Custom token`.
2. Grant permissions:
   - `Account:Workers Scripts` -> Edit
   - `Account:D1` -> Edit
   - `Account:R2 Storage` -> Edit
   - `Account:Queues` -> Edit
3. Scope token to your account.
4. Create token and copy it once.

Collect values and add to `.env.week0.local`:

1. `CLOUDFLARE_ACCOUNT_ID`
2. `CLOUDFLARE_API_TOKEN`
3. `CLOUDFLARE_WORKERS_SUBDOMAIN`

Login locally:

```bash
wrangler login
```

Then verify:

```bash
wrangler whoami
```

## 4) GitHub setup

Create repo (or use existing) for plugin/backend code.

Enable Actions:

1. Repo `Settings -> Actions -> General`.
2. Allow actions and reusable workflows.
3. Save.

Create fine-grained token (for automation) with repo access and Actions permissions.
Add to `.env.week0.local` as `GITHUB_TOKEN`.

Fill:

1. `GITHUB_ORG_OR_USER`
2. `GITHUB_REPO`
3. `GITHUB_ACTIONS_REF` (`main` unless you use another default branch)

Optional quick CLI auth check:

```bash
gh auth login
gh repo view <owner>/<repo>
```

## 5) Stripe setup (test mode first)

In Stripe dashboard (test mode):

1. Create product `Baseline Starter`.
2. Create product `Baseline Growth`.
3. Create product `Baseline Agency`.
4. Add recurring monthly prices for each.

Collect:

1. `STRIPE_SECRET_KEY` (test key for now)
2. `STRIPE_PRICE_ID_STARTER`
3. `STRIPE_PRICE_ID_GROWTH`
4. `STRIPE_PRICE_ID_AGENCY`

Create Stripe webhook endpoint (week 5 target path):

`https://<your-worker-subdomain>.workers.dev/v1/stripe/webhook`

Subscribe to:

1. `checkout.session.completed`
2. `customer.subscription.created`
3. `customer.subscription.updated`
4. `customer.subscription.deleted`
5. `invoice.payment_failed`

Collect `STRIPE_WEBHOOK_SECRET`.

## 6) App secrets

Generate strong secrets locally:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Use output values for:

1. `JWT_SIGNING_KEY`
2. `ENCRYPTION_KEY`

## 7) Run readiness verifier

Run:

```bash
npm run week0:verify
```

If it fails, fix the missing command/env var shown, then rerun.

## 8) What to send back in chat (safe format)

Do not paste raw secret values. Send this masked checklist:

1. Cloudflare: account id present (`yes/no`), API token present (`yes/no`), wrangler login works (`yes/no`).
2. GitHub: repo ready (`owner/repo`), Actions enabled (`yes/no`), token present (`yes/no`).
3. Stripe: 3 prices created (`yes/no`), webhook secret present (`yes/no`).
4. Verifier: `passed/failed`.

Once that is complete, Week 1 starts with infra bootstrap and I can take over the code and terminal setup flow.
