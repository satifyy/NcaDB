import { createPool, pendingMigrations, waitForDatabase } from '@ncaa/database';
import { buildApp } from './app';
import { loadConfig } from './config';

async function main() {
    const config = loadConfig();
    const pool = createPool({ max: Number(process.env.DATABASE_POOL_MAX || 10), applicationName: 'ncadb-api' });
    await waitForDatabase(pool);
    const app = await buildApp(pool, config);

    const pending = await pendingMigrations(pool);
    if (pending.length > 0) {
        // Served anyway: an older schema still answers the routes it has. The pre-deploy
        // migrate step is what should have run; /api/v1/status reports this too.
        app.log.warn({ pending }, 'database has pending migrations');
    }
    if (!config.adminToken) app.log.info('ADMIN_API_TOKEN unset or shorter than 24 characters; admin routes disabled');

    const shutdown = async (signal: string) => {
        app.log.info({ signal }, 'shutting down');
        await app.close();
        await pool.end();
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
