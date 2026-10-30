# API keys and webhooks

How an organization's other systems (a CRM, an HR system, a data warehouse, its own scripts) work with this app:

- **API keys** let them call the API as the organization.
- **Webhooks** let the app call them when something happens.

Both are on the **Developers** page (Organization → Developers):

- seeing it needs `api:read`;
- making keys and webhooks needs `api:manage` (tenant admins have both).

Code: `backend/src/lib/api-keys.ts`, `backend/src/lib/webhooks.ts`, `routes/api-keys.ts`, `routes/webhooks.ts`.

## API keys

```
curl -H "Authorization: Bearer mtk_…" https://<your domain>/api/users
```

`X-API-Key: mtk_…` works too. A key:

- **Acts for its organization only.** An `x-tenant-id` for another organization is refused.
- **Has fixed permissions,** chosen when it's made from the ones its maker holds organization-wide. It can't have:
  - `api:manage`, so keys can't make keys or change webhooks;
  - `billing:manage`, so it can't pay or change the plan;
  - any platform permission.
- **Keeps its maker's user type** for the rules about whom it may manage (a key made by a manager can't change admins). It doesn't follow later changes to its maker's access: revoke it if that matters.
- **Is shown once.** Only a SHA-256 hash of its secret is stored.
- **Can expire** (30 days, 90 days, a year, or never) and **be revoked** at any time, effective at once.
- **Is recorded as itself** in the audit log, as actor `API_KEY` with the key's name, not as its maker. Its last use (time and address) shows on the Developers page.
- **Is not a person.** Routes for a signed-in person's own account (profile, password, two-factor, notifications inbox) refuse keys with `NOT_FOR_API_KEYS`.

Refusals are 401s, with `code` one of:

- `INVALID_API_KEY`: the key doesn't exist or doesn't match;
- `API_KEY_REVOKED`;
- `API_KEY_EXPIRED`.

The organization's own state still applies: an ended trial or overdue payments make it read-only for keys too.

**Format:** `mtk_<tenant>_<key>_<secret>`, where the tenant and key are the base64url of their ids (which database to look in) and the secret is 24 random bytes.

**Rate limits:** the per-address flood limit (`RATE_LIMIT_MAX` per `RATE_LIMIT_TIME_WINDOW`) applies to keys as to anyone. A system making many calls from one address should stay under it, or the limit should be raised.

**What can be called:** the interactive reference at `/api/docs` lists every route, with the permission each needs. In production it's off unless `API_DOCS=true`.

## Webhooks

An endpoint is a URL plus the events it wants, or *all events* (which includes ones added later). The events are the organization's audit entries. Some examples:

| Event | When |
| --- | --- |
| `user.invited`, `user.deactivated`, `user.reactivated` | People come and go |
| `role.assigned`, `role.unassigned`, `group.member_added` | Access changes |
| `organization.created`, `group.created` | Structure changes |
| `billing.subscribed`, `billing.payment_failed` | The subscription |
| `auth.signed_in`, `auth.sign_in_failed` | Sign-ins (busy: subscribe only if you need them) |

The Developers page lists them all; so does `GET /webhooks/events`.

### What's sent

A `POST` with a JSON body:

```json
{
  "id": "evt_6f1c…",
  "type": "group.created",
  "timestamp": "2026-10-30T12:00:00.000Z",
  "tenantId": "…",
  "data": {
    "actor": { "type": "USER", "id": "…", "email": "admin@example.com" },
    "resource": { "type": "group", "id": "…", "label": "Engineering" },
    "outcome": "SUCCESS",
    "changes": null,
    "details": null,
    "requestId": "…"
  }
}
```

`changes` and `details` are as in the audit log, so secrets are already left out.

### Checking it came from us

Deliveries follow the [Standard Webhooks](https://www.standardwebhooks.com/) format, so its libraries for most languages check them for you. The headers are:

- `webhook-id`: the event's id. It's the same on every retry, so use it to ignore repeats.
- `webhook-timestamp`: seconds since the epoch. Reject old ones (more than 5 minutes) to stop replays.
- `webhook-signature`: `v1,` + base64 of HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}`. The key is the bytes of the secret after `whsec_` (base64-decoded).

In Node, without a library:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
const expected = 'v1,' + createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
const ok = signature.split(' ').some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
```

The signing secret is shown once, when the webhook is added. **New secret** replaces it at once, and is shown once too. Secrets are encrypted at rest (`SECRETS_KEY_V*`).

### Delivery, retries, turning off

- **One row per event per endpoint,** written in the same database transaction as the audit entry. An event is sent if and only if it happened, even if the server stops right after.
- **Taken means 2xx within 10 seconds.** Anything else is a failure: other statuses, redirects (not followed) and timeouts.
- **Retries:** after 1 minute, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours and 24 hours, so 8 attempts over about two days. Then the delivery is given up (*Failed*), and **Send again** gives it another full set of attempts.
- **Turning off:** an endpoint whose deliveries are given up 5 times in a row is turned off. The reason is shown, and it's recorded in the audit log (`webhook.disabled`). Turning it back on starts it afresh.
- **Send test event** posts a `webhook.test` event at once and shows the answer. It isn't retried and doesn't count either way.
- **Deliveries** shows the recent ones with their payload, status, answer and timing. They're kept 30 days.
- **Who sends:** the background jobs, either on the API servers or the worker (`RUN_JOBS`). A delivery is first tried as soon as its event is recorded; retries are picked up every `NOTIFICATION_POLL_MS`.

### Only public addresses

Webhooks go to the public internet only:

- **https** URLs, without a user name or password in them;
- every connection's address is checked as it's made, so private, loopback, link-local, carrier-grade NAT and cloud metadata addresses are refused, even if a name is pointed at them later.

`WEBHOOK_ALLOW_PRIVATE=true` lifts this (and allows plain http) for development and tests only. Never set it in production. Outside production, plain http is allowed anyway.

## Limits

- 50 active keys per organization.
- 20 webhooks per organization.
- Keys and webhook secrets can't be made in a platform support session: they'd outlive it.
