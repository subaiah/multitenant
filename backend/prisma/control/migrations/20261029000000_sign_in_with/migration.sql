-- "Sign in with": the platform as an OpenID Connect provider for the
-- applications in its catalogue (lib/oidc/)
CREATE TYPE "OidcClientType" AS ENUM ('CONFIDENTIAL', 'PUBLIC');

CREATE TABLE "application_sign_ins" (
    "id" TEXT NOT NULL,
    "application_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "client_id" TEXT NOT NULL,
    "client_type" "OidcClientType" NOT NULL DEFAULT 'CONFIDENTIAL',
    "client_secret" TEXT,
    "secret_created_at" TIMESTAMP(3),
    "redirect_uris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "post_logout_redirect_uris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "initiate_login_uri" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_sign_ins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "application_sign_ins_application_id_key" ON "application_sign_ins"("application_id");
CREATE UNIQUE INDEX "application_sign_ins_client_id_key" ON "application_sign_ins"("client_id");
ALTER TABLE "application_sign_ins" ADD CONSTRAINT "application_sign_ins_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "application_registries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "oidc_payloads" (
    "model" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "grant_id" TEXT,
    "user_code" TEXT,
    "uid" TEXT,
    "expires_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "oidc_payloads_pkey" PRIMARY KEY ("model","id")
);

CREATE INDEX "oidc_payloads_grant_id_idx" ON "oidc_payloads"("grant_id");
CREATE INDEX "oidc_payloads_uid_idx" ON "oidc_payloads"("uid");
CREATE INDEX "oidc_payloads_user_code_idx" ON "oidc_payloads"("user_code");
CREATE INDEX "oidc_payloads_expires_at_idx" ON "oidc_payloads"("expires_at");

CREATE TABLE "oidc_signing_keys" (
    "id" TEXT NOT NULL,
    "private_jwk" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "oidc_signing_keys_pkey" PRIMARY KEY ("id")
);
