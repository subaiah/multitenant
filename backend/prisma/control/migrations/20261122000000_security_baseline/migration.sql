-- The platform's security baseline (Global policies): minimums every
-- organization meets, which they can tighten but never loosen
-- (lib/security-baseline.ts). One row, id 'platform'.
CREATE TABLE "security_baseline" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "min_password_policy" TEXT NOT NULL DEFAULT 'STANDARD',
    "mfa_required_for" TEXT NOT NULL DEFAULT 'NONE',
    "max_idle_minutes" INTEGER,
    "max_session_hours" INTEGER,
    "emailed_codes_allowed" BOOLEAN NOT NULL DEFAULT true,
    "staff_ip_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_baseline_pkey" PRIMARY KEY ("id")
);
