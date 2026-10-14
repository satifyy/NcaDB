/**
 * The dashboard's derived JSON (ratings, forecasts, impact, per-season player totals),
 * computed by the analytics stages and served by the API.
 */

import { createHash } from 'crypto';
import { Pool } from 'pg';

export interface ArtifactWrite {
    key: string;
    content: string;
}

/** Valid artifact keys: relative paths like `analytics/predictions/2025.json`. */
export const ARTIFACT_KEY = /^[a-z0-9_\-]+(\/[a-z0-9_\-]+)*\.json$/i;

export async function saveArtifacts(
    pool: Pool,
    runId: number | null,
    artifacts: ArtifactWrite[]
): Promise<{ written: number; unchanged: number }> {
    let written = 0;
    for (const artifact of artifacts) {
        if (!ARTIFACT_KEY.test(artifact.key)) throw new Error(`Invalid artifact key: ${artifact.key}`);
        JSON.parse(artifact.content); // refuse to store anything the dashboard could not parse
        const hash = createHash('sha256').update(artifact.content).digest('hex').slice(0, 32);
        const { rowCount } = await pool.query(
            `INSERT INTO derived_artifacts (key, content, content_hash, byte_size, run_id, generated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (key) DO UPDATE SET
                 content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
                 byte_size = EXCLUDED.byte_size, run_id = EXCLUDED.run_id, generated_at = now()
             WHERE derived_artifacts.content_hash <> EXCLUDED.content_hash`,
            [artifact.key, artifact.content, hash, Buffer.byteLength(artifact.content), runId]
        );
        written += rowCount ?? 0;
    }
    return { written, unchanged: artifacts.length - written };
}
