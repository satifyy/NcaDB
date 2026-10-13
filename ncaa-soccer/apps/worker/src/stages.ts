/**
 * Runs the existing scraper scripts as child processes.
 *
 * They are scripts with their own `process.exit` paths and a Playwright pool whose
 * memory is reclaimed only when the process ends, which is why `run_pipeline.ts` already
 * runs them this way. The worker does the same and points them at its scratch tree.
 */

import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import { WorkerConfig } from './config';
import { log } from './log';

const running = new Set<ChildProcess>();

export interface StageResult {
    code: number;
    seconds: number;
    /** The last lines the stage printed, for the run's error record. */
    tail: string[];
}

export function runScript(config: WorkerConfig, script: string, args: string[]): Promise<StageResult> {
    const tsx = path.join(config.codeRoot, 'node_modules/.bin/tsx');
    const scriptPath = path.join(config.codeRoot, 'apps/scraper/src/scripts', script);
    const started = Date.now();
    const tail: string[] = [];
    const keep = (chunk: Buffer, stream: NodeJS.WriteStream) => {
        stream.write(chunk);
        for (const line of chunk.toString('utf8').split('\n')) {
            if (!line.trim()) continue;
            tail.push(line.slice(0, 500));
            if (tail.length > 60) tail.shift();
        }
    };

    log.info('stage started', { script, args });
    return new Promise(resolve => {
        const child = spawn(tsx, [scriptPath, ...args], {
            cwd: config.codeRoot,
            env: { ...process.env, NCAA_REPO_ROOT: config.workDir },
            stdio: ['ignore', 'pipe', 'pipe'],
            // Its own process group, so a termination signal reaches the grandchildren
            // run_pipeline spawns and the Chromium they launch.
            detached: true
        });
        running.add(child);
        child.stdout!.on('data', chunk => keep(chunk, process.stdout));
        child.stderr!.on('data', chunk => keep(chunk, process.stderr));
        const finish = (code: number) => {
            running.delete(child);
            const result = { code, seconds: Math.round((Date.now() - started) / 1000), tail };
            log.info('stage finished', { script, code, seconds: result.seconds });
            resolve(result);
        };
        child.on('close', code => finish(code ?? 1));
        child.on('error', err => {
            tail.push(`could not start: ${err.message}`);
            finish(1);
        });
    });
}

/** Kills every stage still running, with its whole process group. */
export function killRunningStages(): void {
    for (const child of running) {
        try {
            if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch {
            /* already gone */
        }
    }
}
