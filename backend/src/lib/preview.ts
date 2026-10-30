/**
 * Features that show sample data rather than real measurements: hidden in
 * production unless PREVIEW_FEATURES=true (config/env.ts). Keep this list in
 * step with the frontend's routes (src/App.tsx, <Preview>).
 *
 * - Deployed applications and their CPU, memory and request figures: nothing
 *   reports real deployments yet, so only the demo seed fills them.
 * - API gateway settings (gateway, rate limit, CORS, versioning): stored, not
 *   enforced.
 * - The backup and encryption-at-rest switches: recorded, but nothing acts on
 *   them; backups are the operator's job (docs/DEPLOYMENT.md).
 * - The platform's Global Policies and Settings pages: "coming soon" only.
 */
import { config } from '../config/env.js';

/** Menu entries for preview pages (both portals) */
export const PREVIEW_MENU_PATHS = ['/deployments', '/infrastructure', '/api', '/platform/policies', '/platform/settings'];

/** Database settings that are switches only */
export const PREVIEW_DATABASE_FIELDS = ['backupEnabled', 'encryptionAtRest'];

export const previewEnabled = () => config.previewFeatures;
