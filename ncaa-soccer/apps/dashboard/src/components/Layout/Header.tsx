import { Search, Trophy } from 'lucide-react';
import type { ChangeEvent } from 'react';

interface HeaderProps {
    onSearch: (term: string) => void;
}

export function Header({ onSearch }: HeaderProps) {
    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        onSearch(e.target.value);
    };

    return (
        <header className="header" style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1.5rem 0',
            borderBottom: '1px solid var(--color-bg-tertiary)',
            marginBottom: '2rem'
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{
                    backgroundColor: 'var(--color-accent-light)',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--color-accent-primary)'
                }}>
                    <Trophy size={24} />
                </div>
                <div>
                    <h1 style={{ fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.025em' }}>
                        NCAA Soccer Analytics
                    </h1>
                    <p className="text-muted text-sm">2025 Season • Player Performance Aggregation</p>
                </div>
            </div>

            <div style={{ position: 'relative', width: '320px' }}>
                <Search size={18} style={{
                    position: 'absolute',
                    left: '12px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--color-text-muted)'
                }} />
                <input
                    type="text"
                    placeholder="Search players or teams..."
                    onChange={handleChange}
                    style={{
                        width: '100%',
                        padding: '0.625rem 1rem 0.625rem 2.5rem',
                        backgroundColor: 'var(--color-bg-secondary)',
                        border: '1px solid var(--color-bg-tertiary)',
                        borderRadius: 'var(--radius-full)',
                        color: 'var(--color-text-primary)',
                        fontSize: '0.875rem',
                        outline: 'none',
                        transition: 'border-color 0.2s'
                    }}
                    onFocus={(e) => e.target.style.borderColor = 'var(--color-accent-primary)'}
                    onBlur={(e) => e.target.style.borderColor = 'var(--color-bg-tertiary)'}
                />
            </div>
        </header>
    );
}
