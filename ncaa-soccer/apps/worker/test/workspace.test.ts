import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensurePrivateDir, prepareWorkDir } from '../src/workspace';
import type { WorkerConfig } from '../src/config';

test('the scratch tree can be prepared repeatedly from read-only code (as in the image)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncadb-ws-'));
    const codeRoot = path.join(root, 'code');
    const workDir = path.join(root, 'work');
    fs.mkdirSync(path.join(codeRoot, 'data/teams'), { recursive: true });
    fs.mkdirSync(path.join(codeRoot, 'data/ratings'), { recursive: true });
    fs.writeFileSync(path.join(codeRoot, 'data/teams/d1_msoc_teams.json'), '[]');
    fs.writeFileSync(path.join(codeRoot, 'data/ratings/model.json'), '{}');
    // Read-only, like `chmod -R a-w /app` in the Dockerfiles.
    for (const p of ['data/teams/d1_msoc_teams.json', 'data/ratings/model.json']) fs.chmodSync(path.join(codeRoot, p), 0o444);
    for (const p of ['data/teams', 'data/ratings']) fs.chmodSync(path.join(codeRoot, p), 0o555);
    try {
        const config = { codeRoot, workDir } as WorkerConfig;
        prepareWorkDir(config); // hydrate
        prepareWorkDir(config); // analytics, same process: used to fail with EACCES
        fs.writeFileSync(path.join(workDir, 'data/teams/extra.json'), '{}'); // the copy is writable
        assert.equal(fs.readFileSync(path.join(workDir, 'data/ratings/model.json'), 'utf8'), '{}');
    } finally {
        for (const p of ['data/teams', 'data/ratings']) fs.chmodSync(path.join(codeRoot, p), 0o755);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the work directory is private and may not be a symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncadb-ws-'));
    try {
        const dir = path.join(root, 'work');
        fs.mkdirSync(dir, { mode: 0o777 });
        fs.chmodSync(dir, 0o777);
        ensurePrivateDir(dir);
        assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

        const elsewhere = path.join(root, 'elsewhere');
        fs.mkdirSync(elsewhere);
        const link = path.join(root, 'link');
        fs.symlinkSync(elsewhere, link);
        assert.throws(() => ensurePrivateDir(link), /not a plain directory/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
