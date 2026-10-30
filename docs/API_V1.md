# API v1

The API other systems build on. Call it at `https://<your domain>/api/v1/...` with an API key ([API_ACCESS.md](API_ACCESS.md)):

```sh
curl -H "Authorization: Bearer mtk_…" https://app.example.com/api/v1/users?status=ACTIVE
```

## What's in it

| Area | Routes |
| --- | --- |
| People | `GET /users`, `GET /users/{id}`, `POST /users` (invite), `PATCH /users/{id}`, `DELETE /users/{id}` |
| Groups | `GET /groups`, `GET /groups/{id}`, `POST /groups`, `PATCH /groups/{id}`, `DELETE /groups/{id}`, `POST /groups/{id}/members`, `DELETE /groups/{id}/members/{userId}` |
| Organizations | `GET /organizations`, `GET /organizations/{id}`, `POST /organizations`, `PATCH /organizations/{id}`, `DELETE /organizations/{id}`, `POST /organizations/{id}/members`, `DELETE /organizations/{id}/members/{userId}` |
| Roles | `GET /roles`, `GET /roles/assignments`, `POST /roles/assign`, `DELETE /roles/assignments/{id}` |
| Audit log | `GET /audit` |
| Events | Webhooks: the `WebhookEvent` payload |

The full description, with every parameter, body and answer, is the OpenAPI 3.1 document:

- **Live:** `GET /api/v1/openapi.json` on your server (public).
- **In the repository:** `docs/api/openapi-v1.json`, which is what the client is generated from.

Each route says which permission the key needs (`x-permission`). Errors have the same shape everywhere: `{ "error", "message", "code"? }`.

## Compatibility

Within v1 there are only additions:

- **Allowed:**
  - new routes;
  - new optional parameters;
  - new fields in answers;
  - new values where a field is documented as open.
- **Never:**
  - removing or renaming a route, field or parameter;
  - changing a field's type;
  - making a parameter or field required;
  - removing a value from an enum.

So ignore fields you don't know, and accept new values where a field is documented as open.

A breaking change would be a new version (`/v2`), with v1 kept running alongside it for a published period.

How that's enforced:

- **`test/api-v1.test.ts`:**
  - calls every v1 route with an API key and checks each answer against the contract's schemas;
  - checks each route refuses a key without its permission;
  - checks the committed document matches `src/api/v1.ts`.
- **CI on every pull request:** compares the contract with the base branch's and fails on anything breaking (`npm run openapi -- --check`).

Answers may carry more fields than the document lists. Only the listed ones are promised.

## The TypeScript client

`clients/typescript` is a typed client generated from the document. Paths, parameters, bodies and answers are all checked by the compiler:

```ts
import { createClient } from '@multitenant/api-client';

const api = createClient({ baseUrl: 'https://app.example.com/api/v1', apiKey: process.env.MULTITENANT_API_KEY! });
const { data, error } = await api.GET('/users', { params: { query: { status: 'ACTIVE' } } });
```

Its [README](../clients/typescript/README.md) covers installing it. For other languages, generate a client from `openapi-v1.json` with any OpenAPI generator.

## For developers of this app

The contract lives in `backend/src/api/v1.ts`. To add to v1:

1. Add the route to `ENDPOINTS`, with its permission, body and answer schemas (in `SCHEMAS` if shared).
2. Add a call to it in `test/api-v1.test.ts`. The test fails if any route in the contract isn't called.
3. Run `npm run openapi` (in `backend/`) and `npm run generate` (in `clients/typescript/`), and commit both files.

Every route is also reachable under `/v1`, but only the ones in the contract are promised. The app's own pages call the unversioned paths, which may change at any time.
