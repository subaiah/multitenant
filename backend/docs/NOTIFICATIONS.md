# Notifications

In-app notifications (the bell, and the Notifications page) and email, for tenant users and
platform users. Code: `src/lib/notifications.ts`, the kinds of notification in
`src/kit/notification-types.ts`, endpoints in `src/routes/notifications.ts`.

## What people are told

Most notifications come from audit events. When the audit log records an entry whose key is a
notification type, the people it concerns are told.

| | Examples | Goes to |
| --- | --- | --- |
| **Security** (can't be turned off) | two-factor code rejected after a correct password, password changed, two-factor turned off or reset by an admin | the account's owner |
| **Access** | role given or taken away (directly or through a group), added to or removed from a group, role delegated to you, access request decided, your user type changed | the person concerned (group members for group roles) |
| **For approvers and admins** | someone asked for access; sign-in settings or identity providers changed; a user created through single sign-on; platform support started working in the organization | everyone with the relevant permission, e.g. `access-requests:approve`, `auth:manage` |
| **Platform** | tenant ready, setup failed, deleted; support session started; your two-factor reset | platform staff with the permission, e.g. `tenants:manage` |

The person who did something isn't told about it. Only active users are notified.

## Who decides what arrives

1. **The type** sets the defaults: which channels (in-app and/or email), and whether it's
   *mandatory*. Built-in security notices are mandatory.
2. **The organization:** tenant admins with `notifications:manage` use *Notifications →
   Organization* to:
   - turn a type off;
   - limit it to in-app or email;
   - make it required for everyone, so people can't opt out.

   Built-in security notices can't be turned off.
3. **The person:** *Notifications → My preferences* chooses in-app and email per type,
   within what the organization allows. Mandatory types can't be turned off. Types sent to
   "everyone with permission X" are only listed for people who have it.

## How it's delivered

- **Reliable.** The notification is queued (`notification_outbox`) in the same database
  transaction as the audit entry, so it can't be lost or sent for something that didn't
  happen. The server that recorded it processes it straight away.
- **Fan-out.** Processing writes each recipient's in-app notification and queues their email.
  This happens in one transaction, so a retry never sends twice.
- **Retries.**
  - Emails that fail are retried after 1 and 5 minutes, then 30 minutes, then 2 and 12 hours.
  - After that they're marked failed. Admins see them under *Email delivery* and can resend.
- **Leftover work.** `notification_work` (control plane) lists the logs with work due. A
  periodic sweep (`NOTIFICATION_POLL_MS`) picks up retries, and work a stopped server left
  behind, without visiting every tenant database. Rows are claimed before processing, so
  several servers can run it.
- **Where things are stored.** Tenant users' notifications, preferences and queue live in
  the tenant's own data, in every isolation mode. Platform users' live in the control plane.
- **Retention.** In-app notifications older than `NOTIFICATION_RETENTION_DAYS` (90) are
  removed daily.
- **Email setup.** Email uses the existing mail settings (`EMAIL_TRANSPORT`, `SMTP_URL`,
  `MAIL_FROM`). Each email links to the item and to the preferences page.
- **The bell.** It checks the unread count every 30 seconds as a *background* request
  (`x-background-request: 1`). That request doesn't count as activity, so it never keeps an
  idle session alive.

## Notifications from the main application

Declare types in `src/product/index.ts`:

```ts
notificationTypes: {
  // Raised when the audit event of the same key is recorded…
  'invoice.approved': {
    label: 'Invoice approved',
    description: 'An invoice you submitted was approved',
    category: 'product',
    scope: 'tenant',
    defaults: { inApp: true, email: true },
    audience: (e) => ({ userIds: [e.details?.submittedBy], excludeActor: true }),
    render: (e) => ({ title: `Invoice ${e.resource.label} was approved`, link: `/invoices/${e.resource.id}` }),
  },
  // …or sent directly
  'invoice.due_soon': { /* … */ audience: () => ({ permission: 'invoices:approve' }), /* … */ },
},
```

- **Raised by an audit event:** record it as usual with
  `audit(request, 'invoice.approved', {...})` and the notification follows.
- **Sent directly:** for something that isn't an audit event (a reminder, a scheduled job),
  call `notify({ tenantId }, 'invoice.due_soon', { resource, details, recipients })`.
- **Audiences:** `userIds`, `groupIds`, `permission`, `excludeActor`. They can be combined.
- **New channels:** a channel is one place in `fanOut()` plus a column in the preferences.
  Slack, Teams or webhooks can be added the same way later.
