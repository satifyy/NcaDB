/**
 * The signed-in state as the rest of the site sees it: the shape, the context and the
 * hook. The provider that fills it from Clerk is in session.tsx (a component module, so
 * React Fast Refresh keeps working).
 */

import { createContext, useContext } from 'react';

export interface SessionUser {
    id: string;
    name: string | null;
    email: string | null;
}

export interface Session {
    /** Sign-in is configured for this build. */
    enabled: boolean;
    /** Clerk has loaded and knows whether someone is signed in. */
    loaded: boolean;
    /** Clerk could not load (blocked, offline). The statistics still work. */
    failed: boolean;
    signedIn: boolean;
    user: SessionUser | null;
    /** A fresh session token for an API call, or null when signed out. */
    getToken(): Promise<string | null>;
    /** Leaves for the hosted sign-in or sign-up page; comes back to `returnTo`. */
    signIn(returnTo?: string): void;
    signUp(returnTo?: string): void;
    /** Ends the session everywhere Clerk knows of in this browser, then goes home. */
    signOut(): Promise<void>;
    /** Clerk's hosted page for email, password, connected accounts and security. */
    manageAccount(): void;
}

export const disabled: Session = {
    enabled: false,
    loaded: true,
    failed: false,
    signedIn: false,
    user: null,
    getToken: async () => null,
    signIn: () => undefined,
    signUp: () => undefined,
    signOut: async () => undefined,
    manageAccount: () => undefined
};

export const SessionContext = createContext<Session>(disabled);

export const useSession = () => useContext(SessionContext);

