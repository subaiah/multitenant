/**
 * Where the OpenID Connect provider keeps its state: the control plane's
 * oidc_payloads table, one row per (model, id). Clients are not stored here:
 * they are the applications in the catalogue with "Sign in with" turned on
 * (application_sign_ins), read fresh on every lookup so a change applies at once.
 *
 * Follows oidc-provider's adapter contract (its memory adapter is the reference).
 */
import { controlDb } from '../prisma.js';
import { decryptSecret, secretContext } from '../secrets.js';
import type { Prisma } from '../../generated/control/index.js';

type Payload = Record<string, unknown> & { grantId?: string; userCode?: string; uid?: string; consumed?: number };

const epoch = () => Math.floor(Date.now() / 1000);

// What a grant issues: revoking the grant revokes these (not the interaction
// or session that merely mention it)
const GRANTABLE = ['AccessToken', 'AuthorizationCode', 'RefreshToken', 'DeviceCode', 'BackchannelAuthenticationRequest', 'PreAuthorizedCode'];

/** The client metadata the provider needs for an application, or undefined if it can't sign in. */
export async function clientMetadata(clientId: string): Promise<Record<string, unknown> | undefined> {
  const signIn = await controlDb.applicationSignIn.findUnique({
    where: { clientId },
    include: { application: { select: { name: true, status: true } } },
  });
  if (!signIn || !signIn.enabled || signIn.application.status !== 'ACTIVE') return undefined;
  const confidential = signIn.clientType === 'CONFIDENTIAL';
  if (confidential && !signIn.oidcClientSecret) return undefined;
  return {
    client_id: signIn.clientId,
    client_name: signIn.application.name,
    ...(confidential && { client_secret: decryptSecret(signIn.oidcClientSecret!, secretContext('oidcClientSecret')) }),
    token_endpoint_auth_method: confidential ? 'client_secret_basic' : 'none',
    application_type: 'web',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    redirect_uris: signIn.redirectUris,
    post_logout_redirect_uris: signIn.postLogoutRedirectUris,
  };
}

export class OidcAdapter {
  constructor(private readonly model: string) {}

  async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
    const data = {
      payload: payload as Prisma.InputJsonValue,
      grantId: payload.grantId ?? null,
      userCode: payload.userCode ?? null,
      uid: payload.uid ?? null,
      expiresAt: typeof expiresIn === 'number' ? new Date(Date.now() + expiresIn * 1000) : null,
      consumedAt: null,
    };
    await controlDb.oidcPayload.upsert({
      where: { model_id: { model: this.model, id } },
      create: { model: this.model, id, ...data },
      update: data,
    });
  }

  async find(id: string): Promise<Payload | undefined> {
    if (this.model === 'Client') return clientMetadata(id);
    const row = await controlDb.oidcPayload.findUnique({ where: { model_id: { model: this.model, id } } });
    return present(row);
  }

  async findByUid(uid: string): Promise<Payload | undefined> {
    const row = await controlDb.oidcPayload.findFirst({ where: { model: this.model, uid } });
    return present(row);
  }

  async findByUserCode(userCode: string): Promise<Payload | undefined> {
    const row = await controlDb.oidcPayload.findFirst({ where: { model: this.model, userCode } });
    return present(row);
  }

  async consume(id: string): Promise<void> {
    const row = await controlDb.oidcPayload.findUnique({ where: { model_id: { model: this.model, id } } });
    if (!row) return;
    await controlDb.oidcPayload.update({
      where: { model_id: { model: this.model, id } },
      data: { consumedAt: new Date(), payload: { ...(row.payload as object), consumed: epoch() } },
    });
  }

  async destroy(id: string): Promise<void> {
    await controlDb.oidcPayload.deleteMany({ where: { model: this.model, id } });
  }

  /** Every token from one grant (a revoked refresh token takes its access tokens with it) */
  async revokeByGrantId(grantId: string): Promise<void> {
    await controlDb.oidcPayload.deleteMany({ where: { grantId, model: { in: GRANTABLE } } });
  }
}

function present(row: { payload: unknown; expiresAt: Date | null } | null): Payload | undefined {
  if (!row || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return undefined;
  return row.payload as Payload;
}

/** Expired rows: removed by a background job (lib/jobs.ts) */
export async function purgeExpiredOidcPayloads(): Promise<number> {
  const { count } = await controlDb.oidcPayload.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}
