/**
 * Shared request helpers: pagination, sorting, id parsing and errors with stable codes.
 */

import { FastifyReply } from 'fastify';

export class ApiError extends Error {
    constructor(
        public readonly statusCode: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
    }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);

export const paginationQuery = {
    page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
    page_size: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
} as const;

export interface Page {
    page: number;
    page_size: number;
}

export const offset = (p: Page) => (p.page - 1) * p.page_size;

/** `{ data, pagination }`, with the total taken from a `count(*) OVER ()` column. */
export function paged<T extends { total_count?: string | number }>(rows: T[], p: Page) {
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;
    return {
        data: rows.map(({ total_count: _omit, ...rest }) => rest),
        pagination: { page: p.page, page_size: p.page_size, total, pages: Math.ceil(total / p.page_size) }
    };
}

/**
 * Turns `?sort=-goals` into an ORDER BY clause from a whitelist. User input never
 * reaches the SQL text: only the whitelist's values do.
 */
export function orderBy(sort: string | undefined, allowed: Record<string, string>, fallback: string): string {
    if (!sort) return fallback;
    const desc = sort.startsWith('-');
    const column = allowed[desc ? sort.slice(1) : sort];
    if (!column) throw new ApiError(400, 'invalid_sort', `Cannot sort by "${sort}". Allowed: ${Object.keys(allowed).join(', ')}`);
    return `${column} ${desc ? 'DESC' : 'ASC'} NULLS LAST`;
}

export const sortEnum = (keys: string[]) => ({ type: 'string', enum: keys.flatMap(k => [k, `-${k}`]) });

export function cacheable(reply: FastifyReply, seconds: number): void {
    reply.header('Cache-Control', `public, max-age=${seconds}, s-maxage=${seconds * 2}, stale-while-revalidate=${seconds * 4}`);
}

export const idParam = {
    type: 'object',
    properties: { id: { type: 'integer', minimum: 1 } },
    required: ['id']
} as const;

/** Team routes accept the numeric id or the slug (`nc-state`). */
export const teamIdParam = {
    type: 'object',
    properties: { id: { type: 'string', pattern: '^([0-9]+|[a-z0-9-]{1,80})$' } },
    required: ['id']
} as const;
