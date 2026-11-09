# ADR-0001: Application-to-application calls

**Status:** Proposed
**Date:** 9 Nov 2026
**Gap:** G1 in [HUB_GAPS.md](../hub/HUB_GAPS.md)

## Context

Generic applications (Hearth, Documents) are used from inside specific applications (AppForge, CRMForge). Two kinds of call are needed:

1. **Machine calls.** CRMForge's server creates a record thread in Hearth when a deal is created; no person is involved.
2. **Calls on behalf of a person.** A person viewing a deal in CRMForge loads the deal's Hearth thread; Hearth must apply *that person's* access, not CRMForge's.

Today the platform issues service tokens only for its own API v1 (`aud: urn:multitenant:api:v1`, `lib/product-service.ts`), and sign-in tokens only to the application the person signed in to. Nothing lets one application prove to another who it is, which organization the call is for, or which person it acts for.

## Options considered

| Option | For | Against |
| --- | --- | --- |
| A. Shared secrets between each pair of applications | Simple | N×N secrets; no per-organization control; no person context; no revocation from the hub |
| B. Forward the person's access token to the other application | No new endpoint | Token audience is the wrong application; forwarding bearer tokens widens what a leak exposes; no machine calls |
| C. Calls proxied through the platform | Central control | The platform becomes a bottleneck and must understand every application's API |
| **D. The platform issues audience-scoped tokens: client credentials for machine calls, token exchange (RFC 8693) for calls on behalf of a person** | Standard; reuses the existing OIDC provider, keys and service credentials; per-organization approval and instant revocation stay in the hub; direct calls between applications | More work in the token endpoint; target applications verify JWTs |

## Decision

**Option D.**

### Declaring APIs

In manifest v2 ([MANIFEST_V2.md](../hub/MANIFEST_V2.md)):

- `api.audience`: the application's audience, `urn:mt:app:<productId>` (fixed, derived from `productId`).
- `api.scopes`: the scopes it exposes, named `<productId>.<thing>:<action>` (same rule as permissions), each with a description and `allowsOnBehalfOf: true|false`.
- `consumes`: the scopes it needs from other applications, each with a reason shown to organization administrators.

### Machine calls

```
POST /api/oidc/token
Authorization: Basic <service credential>
grant_type=client_credentials
&resource=urn:mt:app:hearth
&scope=hearth.threads:write
&organization_id=<tenant id>
```

The target is named with `resource` (RFC 8707), not `audience`. That's how the platform's OIDC provider (oidc-provider, with resource indicators) already selects the audience of service tokens today (`urn:multitenant:api:v1`). `organization_id` is an extra parameter the token endpoint accepts.

The platform issues a token only if:
- the caller's manifest `consumes` that scope, and the target exposes it;
- both applications are `ACTIVE`;
- the organization has **both** applications on now, and set up (`READY`);
- the organization has not blocked this connection (see Approval).

Token claims: `iss`, `aud` (target), `client_id`, `product_id` (caller), `tenant_id` (the same name as in ID tokens), `scope`, `exp` (10 minutes), `jti`.

### Calls on behalf of a person

The caller's server exchanges the person's access token (issued to the caller) for one addressed to the target:

```
POST /api/oidc/token
Authorization: Basic <service credential>
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<person's access token for CRMForge>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&resource=urn:mt:app:hearth
&scope=hearth.threads:read hearth.threads:write
```

RFC 8693 allows `resource` or `audience`. The platform takes `resource`, as for client credentials, and accepts `audience` as the same thing. oidc-provider doesn't implement token exchange, so this is a custom grant type (`provider.registerGrantType`). That is most of G1's work.

Additional checks: the subject token is valid and was issued to the caller; the scope allows on-behalf-of; the person is active and their organization still has both applications on.

Claims add `sub` (the person), and `act: { sub: <caller client_id> }` (who is acting), plus the person's `permissions` **for the target application** (as at sign-in to the target). The target applies the person's permissions, never the caller's.

Lifetime: 5 minutes. No refresh token; the caller exchanges again.

### Approval by organizations

- Default: when an organization has both applications on, connections declared in manifests are **allowed**, and listed on the organization's Application Entitlements page ("CRMForge can create and read Hearth threads").
- Administrators can **block** a connection; blocked connections get `access_denied` at the token endpoint at once.
- Every issued exchange token is counted per connection (not logged per call), and blocks and unblocks go to the organization's audit log.

### Verifying in the target application

- Fetch the platform's JWKS (already published for OIDC); cache keys; accept `typ: at+jwt`.
- Check `iss`, `aud` equals its own audience, `exp`, `scope`, and `tenant_id`; scope every query by `tenant_id`.
- For on-behalf-of tokens, authorize with the token's `permissions` and `sub`, and record `act.sub` in its own audit entries.
- Revocation: tokens are short-lived; a service credential revoked, an application made inactive, an entitlement removed or a connection blocked stops **new** tokens at once. Applications that need instant cut-off can call the platform's introspection endpoint (to be added) for sensitive operations.

## Consequences

- Positive: one standard mechanism for every pair of applications; generic applications never trust callers blindly; the hub keeps control (entitlements, blocking, revocation) without sitting in the request path.
- Negative: token endpoint grows (`audience`, `organization_id`, token exchange); every exposed API must verify JWTs (provide a small verifier in `clients/typescript`).
- Follow-ups: introspection endpoint; SDK helpers `createAppClient(target)` and `verifyAppToken()`; Integrations page shows connections and their use; contract tests that a token for one organization can't read another's data in the target.

## Not decided here

- Whether exposed APIs are also published as OpenAPI from each application's manifest (recommended; separate ADR).
- Rate limits per connection.
