/**
 * Page-number paging for list endpoints. Out-of-range or malformed values are
 * brought into range rather than refused, and a page holds at most
 * MAX_PAGE_SIZE rows however many are asked for, so one request can't load a
 * whole large table.
 */
import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

const toInt = (value: unknown, fallback: number) => {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** `page` and `limit` from a query string, and the rows to skip */
export function pageOf(page: unknown, limit: unknown, defaultLimit = 20) {
  const size = Math.min(Math.max(toInt(limit, defaultLimit), 1), MAX_PAGE_SIZE);
  const number = Math.max(toInt(page, 1), 1);
  return { page: number, limit: size, skip: (number - 1) * size };
}

/** The same rules for zod query schemas */
export const pageSchema = z.coerce.number().int().catch(1).transform((n) => Math.max(n, 1));
export const limitSchema = (defaultLimit: number) =>
  z.coerce.number().int().default(defaultLimit).catch(defaultLimit).transform((n) => Math.min(Math.max(n, 1), MAX_PAGE_SIZE));
