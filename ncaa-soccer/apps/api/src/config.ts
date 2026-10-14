import { AuthConfig, loadAuthConfig } from './auth';

export interface ApiConfig {
    port: number;
    host: string;
    /** Exact origins, or patterns with `*` standing for one DNS label part (`https://ncadb-*.vercel.app`). */
    corsOrigins: string[];
    /** Bearer token for /api/v1/admin. Unset disables the admin routes entirely. */
    adminToken?: string;
    rateLimitPerMinute: number;
    /** Seconds browsers and CDNs may cache public data responses. */
    cacheSeconds: number;
    version: string;
    /** Clerk session verification. Unset disables sign-in features (user routes return 503). */
    auth?: AuthConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
    return {
        port: Number(env.PORT || 3001),
        host: env.HOST || '0.0.0.0',
        corsOrigins: (env.CORS_ALLOWED_ORIGINS || 'http://localhost:5173')
            .split(',')
            .map(o => o.trim())
            .filter(Boolean),
        adminToken: env.ADMIN_API_TOKEN && env.ADMIN_API_TOKEN.length >= 24 ? env.ADMIN_API_TOKEN : undefined,
        rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE || 300),
        cacheSeconds: Number(env.API_CACHE_SECONDS || 300),
        version: (env.RAILWAY_GIT_COMMIT_SHA || env.GIT_SHA || 'dev').slice(0, 12),
        auth: loadAuthConfig(env)
    };
}

/** Compiles the configured origins into a matcher. */
export function originMatcher(origins: string[]): (origin: string) => boolean {
    const patterns = origins.map(o =>
        o.includes('*')
            ? new RegExp(`^${o.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+')}$`, 'i')
            : o.toLowerCase()
    );
    return origin =>
        patterns.some(p => (typeof p === 'string' ? p === origin.toLowerCase() : p.test(origin)));
}
