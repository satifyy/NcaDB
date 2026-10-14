import { createPool, pendingMigrations, waitForDatabase } from '@ncaa/database';
import { buildApp } from './app';
import { loadConfig } from './config';

async function main() {
    const config = loadConfig();
    // Public read traffic: no query may run long enough to tie up the database.
    const pool = createPool({
        max: Number(process.env.DATABASE_POOL_MAX || 10),
        applicationName: 'ncadb-api',
        statementTimeoutMs: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS || 5_000)
    });
    await waitForDatabase(pool);
    // Signed-in users' own data goes through a second identity, ncadb_accounts, which can
    // reach the accounts schema; the public pool above cannot (see migration 003).
    const accounts =
        config.auth && process.env.ACCOUNTS_DATABASE_URL
            ? createPool({
                  connectionString: process.env.ACCOUNTS_DATABASE_URL,
                  max: Number(process.env.ACCOUNTS_DATABASE_POOL_MAX || 5),
                  applicationName: 'ncadb-api:accounts',
                  statementTimeoutMs: 5_000
              })
            : undefined;
    if (accounts) await waitForDatabase(accounts);
    const app = await buildApp(pool, config, { accounts });

    const pending = await pendingMigrations(pool);
    if (pending.length > 0) {
        // Served anyway: an older schema still answers the routes it has. The pre-deploy
        // migrate step is what should have run; /api/v1/status reports this too.
        app.log.warn({ pending }, 'database has pending migrations');
    }
    if (!config.adminToken) app.log.info('ADMIN_API_TOKEN unset or shorter than 24 characters; operator token disabled');
    if (!accounts) app.log.info('Clerk settings or ACCOUNTS_DATABASE_URL unset; sign-in features disabled');

    const shutdown = async (signal: string) => {
        app.log.info({ signal }, 'shutting down');
        await app.close();
        await pool.end();
        await accounts?.end();
        process.exit(0);
    };
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGINT', () => void shutdown('SIGINT'));

    await app.listen({ port: config.port, host: config.host });
}

main().catch(err => {
    console.error(JSON.stringify({ level: 'error', msg: 'api failed to start', error: (err as Error).message }));
    process.exit(1);
});
