/**
 * Failure notifications through one webhook.
 *
 * The payload carries both `text` (Slack, Mattermost, most generic receivers) and
 * `content` (Discord), so one URL from any of them works without configuration.
 * Never throws: an alert that cannot be delivered is logged, and must not turn a run
 * that succeeded into one that failed.
 */

import { log } from './log';

export async function notify(webhookUrl: string | undefined, title: string, details: Record<string, unknown> = {}) {
    const lines = Object.entries(details).map(([k, v]) => `• ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    const text = [`*NCADB* — ${title}`, ...lines].join('\n').slice(0, 1900);
    if (!webhookUrl) {
        log.warn('alert (no ALERT_WEBHOOK_URL configured)', { title, ...details });
        return;
    }
    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, content: text }),
            signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) log.warn('alert delivery failed', { status: response.status, title });
        else log.info('alert sent', { title });
    } catch (err) {
        log.warn('alert delivery failed', { error: (err as Error).message, title });
    }
}
