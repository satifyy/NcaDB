/**
 * The masthead's account control and the "save" toggle on team and player pages.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { LogIn, LogOut, Shield, Star, User, LayoutDashboard } from 'lucide-react';
import { pagePath } from './config';
import { useAccount } from './account-api';
import { useSession } from './session-context';

function initials(name: string | null, email: string | null): string {
    const source = (name || email || '?').trim();
    const parts = source.split(/[\s@.]+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '?') + (name && parts[1] ? parts[1][0] : '')).toUpperCase();
}

/**
 * "Log in" when signed out; an account menu when signed in. Nothing at all when sign-in
 * is not configured, so the public site looks exactly as it did.
 */
export function AccountMenu() {
    const session = useSession();
    const { profile } = useAccount();
    const [open, setOpen] = useState(false);
    const menuId = useId();
    const root = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDocument = (event: MouseEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
                button.current?.focus();
            }
        };
        document.addEventListener('mousedown', onDocument);
        document.addEventListener('keydown', onKey);
        root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        return () => {
            document.removeEventListener('mousedown', onDocument);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    if (!session.enabled || session.failed) return null;
    if (!session.loaded) return <span className="account-placeholder" aria-hidden="true" />;
    if (!session.signedIn) {
        return (
            <a className="button button-primary account-login" href={pagePath('login')}>
                <LogIn size={16} aria-hidden="true" />
                Log in
            </a>
        );
    }

    const name = profile?.display_name || session.user?.name || session.user?.email || 'Account';
    const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
        items[next]?.focus();
    };

    return (
        <div className="account-menu" ref={root}>
            <button
                ref={button}
                type="button"
                className="account-trigger"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={menuId}
                onClick={() => setOpen(o => !o)}
            >
                <span className="account-avatar" aria-hidden="true">
                    {initials(profile?.display_name || session.user?.name || null, session.user?.email ?? null)}
                </span>
                <span className="account-name">{name}</span>
            </button>
            {open && (
                <div className="account-dropdown" role="menu" id={menuId} aria-label="Account" onKeyDown={onMenuKey}>
                    <a role="menuitem" href={pagePath('dashboard')}>
                        <LayoutDashboard size={16} aria-hidden="true" /> My dashboard
                    </a>
                    <a role="menuitem" href={pagePath('profile')}>
                        <User size={16} aria-hidden="true" /> Profile and favorites
                    </a>
                    {/* A convenience link only: the server decides who is an administrator. */}
                    {profile?.role === 'admin' && (
                        <a role="menuitem" href={pagePath('admin')}>
                            <Shield size={16} aria-hidden="true" /> Admin
                        </a>
                    )}
                    <button role="menuitem" type="button" onClick={() => void session.signOut()}>
                        <LogOut size={16} aria-hidden="true" /> Sign out
                    </button>
                </div>
            )}
        </div>
    );
}

/** Save or unsave a team (by slug) or a player (by id). Signed-out readers are sent to log in. */
export function FavoriteButton({ kind, id, label }: { kind: 'team'; id: string; label: string } | { kind: 'player'; id: number; label: string }) {
    const session = useSession();
    const account = useAccount();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    if (!session.enabled || session.failed || !session.loaded) return null;

    if (!session.signedIn) {
        return (
            <a className="button button-ghost" href={pagePath('login')}>
                <Star size={16} aria-hidden="true" /> Log in to save
            </a>
        );
    }
    const saved = kind === 'team' ? account.isFavoriteTeam(id) : account.isFavoritePlayer(id);
    const toggle = async () => {
        setBusy(true);
        setError(null);
        try {
            if (kind === 'team') await account.toggleTeam(id);
            else await account.togglePlayer(id);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <span className="favorite-control">
            <button
                type="button"
                className={saved ? 'button button-ghost is-on' : 'button button-ghost'}
                aria-pressed={saved}
                disabled={busy || account.loading}
                onClick={() => void toggle()}
            >
                <Star size={16} aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
                {saved ? `Saved` : `Save ${label}`}
            </button>
            {error && (
                <span className="form-error" role="alert">
                    {error}
                </span>
            )}
        </span>
    );
}
