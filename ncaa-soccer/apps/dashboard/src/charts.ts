/**
 * One Chart.js registration and one theme, shared by every chart on the site.
 *
 * Registering controllers per component means each chart file has its own idea of what a
 * grid line looks like, and they drift. Everything visual — grid, axes, tooltip, mark
 * geometry — is defined once here, so a chart file only ever says what data it draws.
 *
 * The series colours are read from CSS custom properties rather than repeated as hex,
 * because they are a validated set defined in `variables.css` and a second copy is a
 * second thing to keep in step.
 */

import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    PointElement,
    LineElement,
    Filler,
    Tooltip,
    Legend
} from 'chart.js';
import type { ChartOptions, ChartType } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler, Tooltip, Legend);

/** Reads a token, so the palette has exactly one definition. */
export function token(name: string, fallback = '#94a3b8'): string {
    if (typeof window === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

/**
 * Categorical series, assigned in order and never cycled.
 *
 * Five is the cap. The sixth validated slot sits below 3:1 against the card surface, and
 * a sixth line is past what a reader can hold against a legend anyway — so callers that
 * could exceed five select a subset instead.
 */
export const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5'] as const;
export const MAX_SERIES = SERIES.length;

export function seriesColor(index: number): string {
    return token(SERIES[index % SERIES.length]);
}

/** Home and away are opposed outcomes; the draw is the neutral middle. */
export const OUTCOME_COLORS = {
    home: '--series-home',
    draw: '--series-draw',
    away: '--series-away'
} as const;

const tooltip = () => ({
    backgroundColor: token('--color-bg-elevated', '#243146'),
    titleColor: token('--color-text-primary', '#f8fafc'),
    bodyColor: token('--color-text-secondary', '#94a3b8'),
    borderColor: token('--color-border', '#334155'),
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    boxPadding: 4,
    titleFont: { weight: 600 as const }
});

/**
 * Chart defaults: recessive furniture, a hover layer on by default.
 *
 * An HTML chart is interactive whether or not anyone planned for it, so the tooltip and
 * its hit behaviour are part of the baseline rather than something each chart opts into.
 */
export function baseOptions<T extends ChartType = 'bar'>(): ChartOptions<T> {
    const grid = token('--chart-grid', 'rgba(148,163,184,0.14)');
    const axis = token('--chart-axis', '#64748b');
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        plugins: {
            legend: { display: false },
            tooltip: tooltip()
        },
        scales: {
            x: {
                grid: { display: false },
                border: { color: grid },
                ticks: { color: axis, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 }
            },
            y: {
                grid: { color: grid },
                border: { display: false },
                ticks: { color: axis, font: { size: 11 } }
            }
        }
    } as ChartOptions<T>;
}

/** Bars: thin marks, rounded data-ends, anchored to the baseline. */
export const BAR_GEOMETRY = {
    borderRadius: 4,
    borderSkipped: false as const,
    barPercentage: 0.72,
    categoryPercentage: 0.82
};

/** Lines: 2px, no fill, markers only where they can be hit. */
export const LINE_GEOMETRY = {
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHitRadius: 12,
    tension: 0.25
};
