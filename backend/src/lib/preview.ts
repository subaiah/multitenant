/**
 * Features that show sample data rather than real measurements: hidden in
 * production unless PREVIEW_FEATURES=true (config/env.ts). Keep this list in
 * step with the frontend's routes (src/App.tsx, <Preview>).
 *
 * - The backup and encryption-at-rest switches: recorded, but nothing acts on
 *   them; backups are the operator's job (docs/DEPLOYMENT.md).
 * - The platform's Global Policies page: "coming soon" only.
 */
import { config } from '../config/env.js';

/** Menu entries for preview pages (both portals) */
export const PREVIEW_MENU_PATHS = ['/platform/policies'];

/** Database settings that are switches only */
export const PREVIEW_DATABASE_FIELDS = ['backupEnabled', 'encryptionAtRest'];

export const previewEnabled = () => config.previewFeatures;
