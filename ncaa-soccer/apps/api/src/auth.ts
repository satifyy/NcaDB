/**
 * Authentication for signed-in requests.
 *
 * The browser holds a Clerk session and sends its short-lived session token (a JWT that
 * Clerk re-issues about every minute) as `Authorization: Bearer`. Nothing here sets or
 * reads a cookie, so a cross-site page cannot make a browser send a credential to this
 * API; that is why the user routes need no CSRF token.
 *
 * A token is accepted only if Clerk's verifier passes it (RS256 signature against the
 * instance's key, `exp`/`nbf`/`iat` within a 5 s skew, `azp` one of our origins) and,
 * checked here because the verifier does not, its issuer is our Clerk Frontend API, it
 * names a user and a session, and the session is not pending. What a signed-in user may
 * do is then decided by the role stored in our database, never by a claim or the client.
 */

import { verifyToken } from '@clerk/backend';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { ApiError } from './http';

export interface AuthConfig {
    /** PEM public key from Clerk (networkless verification). Preferred. */
    jwtKey?: string;
    /** Clerk secret key, used only to fetch the JWKS when no jwtKey is given. */
    secretKey?: string;
    /** `iss` every token must carry: the instance's Frontend API URL. */
    issuer: string;
    /** Origins allowed in `azp`: the sites that may obtain tokens for this API. */
    authorizedParties: string[];
}

export interface Principal {
    /** accounts.user_profiles.id */
    userId: number;
    /** The provider's stable user id (`sub`). */
    subject: string;
    sessionId: string;
    role: 'user' | 'admin';
}

declare module 'fastify' {
    interface FastifyRequest {
        principal?: Principal;
    }
}

/** Reads Clerk settings from the environment; undefined (auth disabled) unless complete. */
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
    const jwtKey = env.CLERK_JWT_KEY?.replace(/\\n/g, '\n').trim() || undefined;
    const secretKey = env.CLERK_SECRET_KEY?.trim() || undefined;
    const issuer = env.CLERK_ISSUER?.trim().replace(/\/+$/, '');
    const authorizedParties = (env.CLERK_AUTHORIZED_PARTIES || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean);
    if (!jwtKey && !secretKey) return undefined;
    // Fail closed: a half-configured verifier would accept tokens from any Clerk instance
    // (no issuer) or any site (no authorized parties).
    if (!issuer || !/^https:\/\//.test(issuer)) throw new Error('CLERK_ISSUER must be set to the https Frontend API URL');
    if (authorizedParties.length === 0) throw new Error('CLERK_AUTHORIZED_PARTIES must list the site origins');
    return { jwtKey, secretKey, issuer, authorizedParties };
}

export class Authenticator {
    constructor(
        private readonly config: AuthConfig,
        private readonly accounts: Pool
    ) {}

    /** Verifies the bearer token and returns its claims, or throws a 401. */
    async verify(request: FastifyRequest): Promise<{ subject: string; sessionId: string }> {
        const header = request.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in to use this endpoint');
        let claims: Record<string, unknown>;
        try {
            // Resolves to the payload, or throws a TokenVerificationError with a `reason`.
            claims = (await verifyToken(token, {
                jwtKey: this.config.jwtKey,
                secretKey: this.config.jwtKey ? undefined : this.config.secretKey,
                authorizedParties: this.config.authorizedParties,
                clockSkewInMs: 5_000
            })) as Record<string, unknown>;
        } catch (err) {
            this.reject(request, (err as { reason?: string }).reason ?? 'invalid');
        }
        if (claims.iss !== this.config.issuer) this.reject(request, 'wrong_issuer');
        const subject = claims.sub;
        const sessionId = claims.sid;
        if (typeof subject !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(subject)) this.reject(request, 'no_subject');
        if (typeof sessionId !== 'string' || !sessionId) this.reject(request, 'no_session');
        // A session that still owes a step (an organization choice, a forced reset) is not
        // signed in yet.
        if (claims.sts !== undefined && claims.sts !== 'active') this.reject(request, 'session_pending');
        return { subject, sessionId };
    }

    /** Verifies the token, then finds or creates the caller's profile. */
    async authenticate(request: FastifyRequest): Promise<Principal> {
        const { subject, sessionId } = await this.verify(request);
        // last_seen_at is touched at most once a minute, so a page of requests is one write.
        const { rows } = await this.accounts.query<{ id: number; role: 'user' | 'admin'; created: boolean }>(
            `INSERT INTO accounts.user_profiles (auth_provider, auth_subject) VALUES ('clerk', $1)
             ON CONFLICT (auth_provider, auth_subject) DO UPDATE
                 SET last_seen_at = CASE WHEN accounts.user_profiles.last_seen_at < now() - interval '1 minute'
                                         THEN now() ELSE accounts.user_profiles.last_seen_at END
             RETURNING id::int, role, (xmax = 0) AS created`,
            [subject]
        );
        const principal: Principal = { userId: rows[0].id, subject, sessionId, role: rows[0].role };
        if (rows[0].created) await audit(this.accounts, request, principal, 'account.created');
        return principal;
    }

    private reject(request: FastifyRequest, reason: string): never {
        request.log.warn({ event: 'security.auth_failed', ip: request.ip, path: request.url, reason }, 'authentication failed');
        throw new ApiError(401, 'unauthenticated', 'Your session is invalid or has expired. Sign in again.');
    }
}

/** Appends to the audit trail. Never throws: an audit hiccup must not fail the request. */
export async function audit(
    accounts: Pool,
    request: FastifyRequest,
    principal: Pick<Principal, 'userId' | 'subject'>,
    action: string,
    detail: Record<string, unknown> = {}
): Promise<void> {
    try {
        await accounts.query(
            `INSERT INTO accounts.user_activity_audit (user_id, auth_subject, action, detail, request_id, ip)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [principal.userId, principal.subject, action, JSON.stringify(detail), request.id, request.ip]
        );
    } catch (err) {
        request.log.error({ err, action }, 'audit write failed');
    }
}

/** preHandler: the caller must be signed in. */
export function requireUser(auth: Authenticator) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('Cache-Control', 'no-store');
        request.principal = await auth.authenticate(request);
    };
}
