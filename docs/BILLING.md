# Billing

Organizations pay per user for a plan, by subscription:

- **Razorpay** for prices in Indian rupees: UPI, cards and netbanking.
- **Stripe** for every other currency: cards.

Plans also set **limits** (users, organizations, groups) and **features** (single sign-on, a custom domain), and these are enforced whether or not payments are set up.

Code: `backend/src/lib/billing/` (plans, providers, subscriptions), `routes/billing.ts` (the organization's Billing page), `routes/platform-billing.ts` (Platform → Plans and billing), `routes/billing-webhooks.ts`.

## Plans and limits

There are four plans: Free, Starter, Professional and Enterprise. Platform staff with `plans:manage` edit them on **Plans and billing**:

| Setting | Meaning |
| --- | --- |
| Users | People active or invited. Also the number of seats paid for. Blank: no limit. |
| Organizations, Groups | Blank: no limit. |
| Single sign-on | Adding an identity provider. |
| Custom domain | Setting the organization's own web address. |
| Offered on the Billing page | Shown to organizations. Enterprise starts hidden: arrange it by hand and set the plan on the Tenants page. |

The starting values (Free: 5 users, 1 organization, 5 groups) are only a starting point. Change them to suit.

A limit is checked when something is **added**:

- inviting or creating a user, reactivating one, or a new person signing in with single sign-on when *auto-provision* is on;
- creating an organization or a group;
- adding an identity provider or a custom domain.

Going over a limit is refused with `PLAN_LIMIT` and a message pointing to the Billing page. Nothing that exists is removed when a plan gets smaller, and an organization can't move to a plan it's already too big for (`PLAN_TOO_SMALL`).

Plans can be changed on the Tenants page as before, except for an organization with a paid subscription: its subscription decides its plan (`SUBSCRIBED`).

## Turning payments on

Each provider is on when all its keys are set in `deploy/.env` (then `docker compose up -d`). Use test-mode keys first.

### Razorpay (INR)

1. **Keys.** In the Razorpay Dashboard → *Account & Settings → API Keys*, generate a key. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
2. **Subscriptions.** Turn on *Subscriptions* for the account if it isn't already (*Products*).
3. **Webhook.** Under *Webhooks → Add new webhook*:
   - **URL:** `https://<your domain>/api/bff/billing/webhooks/razorpay`
   - **Secret:** a long random value, which you also put in `RAZORPAY_WEBHOOK_SECRET`.
   - **Events:** every `subscription.*` event (authenticated, activated, charged, pending, halted, cancelled, completed, updated, paused, resumed) and `invoice.paid`.

### Stripe (other currencies)

1. **Key.** In the Stripe Dashboard → *Developers → API keys*, put the secret key (`sk_...`) in `STRIPE_SECRET_KEY`. A restricted key works too, if it can write Prices, Checkout Sessions, Subscriptions, Customer portal sessions and read Invoices.
2. **Webhook.** Under *Developers → Webhooks → Add endpoint*:
   - **URL:** `https://<your domain>/api/bff/billing/webhooks/stripe`
   - **Events:** `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   - **Secret:** put the signing secret (`whsec_...`) in `STRIPE_WEBHOOK_SECRET`.
3. **Customer portal.** Under *Settings → Billing → Customer portal*, save the portal settings once. The **Payment method and invoices** button opens it.

Requests use Stripe API version `2025-03-31.basil`. Webhooks may use your account's own version: the payload is only used to find the subscription, which is then read from the API.

### Prices

On **Plans and billing**, give each paid plan a price per user, per month or per year, in each currency you sell in:

- `INR` makes a Razorpay plan;
- any other currency (`USD`, `EUR`, …) makes a Stripe price.

Prices can't change at the providers, so setting a new price makes a new one. New subscriptions use it, and existing subscriptions keep theirs. **Stop offering** hides a price without touching anyone on it.

Prices are what the customer pays. Taxes (GST, VAT) are not added by this app: set them up at the provider (Razorpay's GST settings, Stripe Tax) if you need them.

## What organizations see

**Billing** (`billing:read` to see, `billing:manage` to change; tenant admins have both) shows:

- the plan and what it allows, and what's used;
- the subscription: price × users, renewal date, status;
- the plans to move to, with a monthly/yearly switch and, before subscribing, the currency;
- invoices, with links to the provider's copy.

**Subscribing:**

1. The organization chooses a plan and is sent to the provider's payment page (Stripe Checkout, or Razorpay's subscription link).
2. Coming back, the page looks the subscription up straight away. The webhook confirms it too, whichever comes first.
3. Paying ends a trial.

Subscribing and paying work while an organization is read-only, since that's the way out of it.

Platform staff in a support session can see the Billing page but not change anything. Money decisions are the organization's own.

## Seats

The seats paid for follow the number of users (active and invited, at least one). The hourly job (`lib/tenant-lifecycle.ts`) compares them and updates the subscription:

- **Stripe:** straight away, prorated: the difference for the rest of the period is charged or credited.
- **Razorpay:** from the next billing cycle (Razorpay doesn't prorate). A subscription paid by **UPI or e-mandate can't be changed** at all. The Billing page then says so, and the organization can cancel and subscribe again by card.

## Changing plan, cancelling

- **Upgrading:** takes effect now, so the new limits apply at once.
- **Downgrading:** now, with credit, at Stripe; from the next cycle at Razorpay.
- **Cancelling:** at the end of the period the organization has paid for. Then it moves to the Free plan. Stripe cancellations can be withdrawn (**Keep subscription**); Razorpay's can't.
- **Closing the organization:** cancels at the period's end.
- **Deleting a tenant:** cancels at once.

## Failed payments

1. When a renewal fails, the provider retries (Stripe's Smart Retries, Razorpay's retry schedule) and the subscription is past due.
2. The organization keeps working for `BILLING_GRACE_DAYS` (7) from the first failure. Its billing admins get a notification and an email, and the Billing page shows the deadline.
3. After that it's **read-only** (`PAYMENT_REQUIRED`) until a payment goes through. Everything can still be read, and the Billing page and data export still work.
4. When the provider reports a successful payment, everything works again.

## How it stays correct

- **Webhook signatures.** Every webhook is checked against the signing secret (HMAC-SHA256: Razorpay's `X-Razorpay-Signature`, Stripe's `Stripe-Signature` within 5 minutes). Bad ones get a 400.
- **Each event once.** Events are recorded by id (`billing_events`) and handled once, so retries are harmless. One that can't be handled gets a 500, so the provider tries again.
- **The provider is the source of truth.** Whatever the trigger (webhook, return from checkout, the hourly job), the subscription is read from the provider's API and applied. A missed webhook is caught within the hour.
- **Audit trail.** Subscribing, plan changes, cancellations, seat changes and failed payments go in the organization's audit log. Price and plan changes go in the platform's.

## Testing

- **Stand-ins.** The automated tests (`backend/test/billing.test.ts`) run against stand-ins for both APIs (`backend/test/fake-payments.ts`), with signed webhooks.
- **Razorpay test mode.** With test keys, use Razorpay's test cards on the subscription link, and send webhooks from the Dashboard.
- **Stripe test mode.** Use card `4242 4242 4242 4242`, and run `stripe listen --forward-to localhost:4000/bff/billing/webhooks/stripe` locally; it prints the webhook secret to use.
