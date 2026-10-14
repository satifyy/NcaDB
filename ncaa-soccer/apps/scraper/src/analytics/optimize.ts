/**
 * Nelder–Mead, because the models here have three or four parameters and no gradients.
 *
 * Every fitted quantity in this codebase — the draw band, the goals model, the weight on
 * returning production — is a handful of numbers chosen to minimise a loss over ~25,000
 * games. A grid fine enough to find them costs more evaluations than a simplex does, and
 * writing derivatives for each loss by hand is how a fitted model quietly stops being
 * fitted. This is 60 lines and it converges on all of them.
 */

export interface FitResult {
    params: number[];
    loss: number;
    iterations: number;
}

/**
 * Minimises `loss` starting from `start`, with `scale` setting the initial simplex size
 * per parameter — a parameter measured in Elo points and one measured in log-odds need
 * very different first steps.
 */
export function minimise(
    loss: (params: number[]) => number,
    start: number[],
    scale: number[],
    maxIterations = 400
): FitResult {
    const n = start.length;
    const simplex: { x: number[]; f: number }[] = [{ x: [...start], f: loss(start) }];
    for (let i = 0; i < n; i++) {
        const x = [...start];
        x[i] += scale[i];
        simplex.push({ x, f: loss(x) });
    }

    const centroid = (exclude: number): number[] => {
        const c = new Array(n).fill(0);
        for (let i = 0; i < simplex.length; i++) {
            if (i === exclude) continue;
            for (let j = 0; j < n; j++) c[j] += simplex[i].x[j];
        }
        return c.map(v => v / (simplex.length - 1));
    };
    const combine = (a: number[], b: number[], t: number) => a.map((v, i) => v + t * (b[i] - v));

    let iterations = 0;
    for (; iterations < maxIterations; iterations++) {
        simplex.sort((a, b) => a.f - b.f);
        const best = simplex[0];
        const worst = simplex[n];
        if (Math.abs(worst.f - best.f) < 1e-10) break;

        const mid = centroid(n);
        const tryPoint = (t: number) => {
            const x = combine(mid, worst.x, t);
            return { x, f: loss(x) };
        };

        const reflected = tryPoint(-1);
        if (reflected.f < best.f) {
            const expanded = tryPoint(-2);
            simplex[n] = expanded.f < reflected.f ? expanded : reflected;
            continue;
        }
        if (reflected.f < simplex[n - 1].f) {
            simplex[n] = reflected;
            continue;
        }
        const contracted = tryPoint(0.5);
        if (contracted.f < worst.f) {
            simplex[n] = contracted;
            continue;
        }
        // Nothing helped: shrink the whole simplex toward the best point.
        for (let i = 1; i < simplex.length; i++) {
            const x = combine(best.x, simplex[i].x, 0.5);
            simplex[i] = { x, f: loss(x) };
        }
    }

    simplex.sort((a, b) => a.f - b.f);
    return { params: simplex[0].x, loss: simplex[0].f, iterations };
}
