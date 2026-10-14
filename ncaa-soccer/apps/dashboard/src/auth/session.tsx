/**
 * The signed-in state, as the rest of the site sees it.
 *
 * Clerk runs headless here (`prefetchUI={false}`): the page loads Clerk's session script
 * from our Clerk domain and nothing else, injects no styles and frames nothing, which is
 * what lets the site keep its strict Content Security Policy. Typing a password, choosing
 * Google, verifying an email and recovering an account all happen on Clerk's hosted
 * Account Portal, and Clerk sends the browser back to `/ncadb/dashboard`.
 *
 * Clerk keeps the session in its own cookies (the long-lived one is HttpOnly on the
 * Clerk domain) and mints a session token that expires after a minute, refreshing it in
 * the background. Nothing here writes a credential to localStorage. Requests to our API
 * carry that short-lived token in the Authorization header.
 *
 * Components use `useSession()`, never Clerk's hooks directly, so they work unchanged
 * when sign-in is switched off.
 */

import { ClerkProvider, useAuth, useClerk, useUser } from '@clerk/react';
import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { absoluteUrl, authEnabled, BASE, CLERK_PUBLISHABLE_KEY, pagePath } from './config';
import { disabled, SessionContext } from './session-context';
import type { Session } from './session-context';

const dashboardUrl = () => absoluteUrl(pagePath('dashboard'));

function ClerkSession({ children }: { children: ReactNode }) {
    const clerk = useClerk();
    const { isLoaded, isSignedIn, getToken } = useAuth();
    const { user } = useUser();

    const token = useCallback(async () => (isSignedIn ? getToken() : null), [isSignedIn, getToken]);
    const value = useMemo<Session>(
        () => ({
            enabled: true,
            loaded: isLoaded,
            failed: clerk.status === 'error',
            signedIn: Boolean(isSignedIn),
            user: user
                ? {
                      id: user.id,
                      name: user.fullName || user.username || null,
                      email: user.primaryEmailAddress?.emailAddress ?? null
                  }
                : null,
            getToken: token,
            signIn: returnTo =>
                void clerk.redirectToSignIn({
                    signInForceRedirectUrl: returnTo ?? dashboardUrl(),
                    signUpForceRedirectUrl: returnTo ?? dashboardUrl()
                }),
            signUp: returnTo =>
                void clerk.redirectToSignUp({
                    signUpForceRedirectUrl: returnTo ?? dashboardUrl(),
                    signInForceRedirectUrl: returnTo ?? dashboardUrl()
                }),
            signOut: () => clerk.signOut({ redirectUrl: absoluteUrl(BASE) }),
            manageAccount: () => void clerk.redirectToUserProfile()
        }),
        [clerk, isLoaded, isSignedIn, user, token]
    );
    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function SessionProvider({ children }: { children: ReactNode }) {
    if (!authEnabled) return <SessionContext.Provider value={disabled}>{children}</SessionContext.Provider>;
    return (
        <ClerkProvider
            publishableKey={CLERK_PUBLISHABLE_KEY}
            prefetchUI={false}
            afterSignOutUrl={absoluteUrl(BASE)}
            signInFallbackRedirectUrl={dashboardUrl()}
            signUpFallbackRedirectUrl={dashboardUrl()}
        >
            <ClerkSession>{children}</ClerkSession>
        </ClerkProvider>
    );
}
