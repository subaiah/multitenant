# @multitenant/api-client

A typed TypeScript client for the Multitenant API v1. It's generated from the API's OpenAPI document (`docs/api/openapi-v1.json`), so paths, parameters, request bodies and answers are all checked by the compiler.

```ts
import { createClient } from '@multitenant/api-client';

const api = createClient({
  baseUrl: 'https://app.example.com/api/v1',
  apiKey: process.env.MULTITENANT_API_KEY!, // from the Developers page
});

// Typed parameters and answer
const { data, error } = await api.GET('/users', { params: { query: { status: 'ACTIVE', limit: 50 } } });
if (error) throw new Error(error.message);
data.data.forEach((u) => console.log(u.email, u.userType));

// Typed body; path parameters too
const { data: group } = await api.POST('/groups', { body: { name: 'Warehouse' } });
await api.POST('/groups/{id}/members', { params: { path: { id: group!.id } }, body: { userId: data.data[0].id } });
```

Requests use [openapi-fetch](https://openapi-ts.dev/openapi-fetch/). A call never throws for an HTTP error: you get `{ data }` or `{ error }`.

To check webhook deliveries, use the `WebhookEvent` type with a [Standard Webhooks](https://www.standardwebhooks.com/) library (see `docs/API_ACCESS.md`).

## Using it

It isn't published to a registry. Either:

- build it and depend on the folder: `npm run build` here, then `npm install ../path/to/clients/typescript`; or
- copy `src/` into your project; it needs only `openapi-fetch`.

## When the API changes

The contract is `backend/src/api/v1.ts`. After changing it:

```sh
cd backend && npm run openapi                       # docs/api/openapi-v1.json
cd ../clients/typescript && npm run generate         # src/schema.d.ts
```

CI checks that both files are up to date, and that v1 stays compatible.
