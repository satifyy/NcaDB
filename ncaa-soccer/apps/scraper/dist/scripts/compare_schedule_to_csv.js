"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const playwright_chromium_1 = require("playwright-chromium");
const sync_1 = require("csv-parse/sync");
const parsers_1 = require("@ncaa/parsers");
// Normalize a boxscore URL using the schedule page as base.
const resolveBoxscoreUrl = (rawUrl, baseUrl) => {
    if (!rawUrl)
        return undefined;
    const trimmed = rawUrl.trim();
    if (!trimmed)
        return undefined;
    if (/^https?:\/\//i.test(trimmed))
        return trimmed;
    const originFromBase = (() => {
        try {
            return new URL(baseUrl).origin;
        }
        catch {
            return '';
        }
    })();
    if (trimmed.startsWith('//'))
        return `https:${trimmed}`;
    if (trimmed.startsWith('/'))
        return originFromBase ? `${originFromBase}${trimmed}` : undefined;
    try {
        return new URL(trimmed, originFromBase || baseUrl).toString();
    }
    catch {
        return undefined;
    }
};
const normalizeKey = (date, home, away) => `${date}__${home.toLowerCase().trim()}__${away.toLowerCase().trim()}`;
const readCsvGames = (year, teamName) => {
    const csvPath = path.resolve(__dirname, `../../../../data/games/${year}/games.csv`);
    const content = fs.readFileSync(csvPath, 'utf8');
    const rows = (0, sync_1.parse)(content, { columns: true });
    return rows.filter((r) => r.home_team_name === teamName || r.away_team_name === teamName);
};
const fetchHtmlLikeV2 = async (url, alias) => {
    const browser = await playwright_chromium_1.chromium.launch({ headless: true, timeout: 60000 });
    const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
    });
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(30000);
    const tableToggleSelector = '#_viewType_table, button[aria-label="Table View"], a[aria-label="Switch to Grid View"], a[data-view="grid"], a:has-text("Grid")';
    const tableSelectorConcrete = '.c-schedule__table, #tablePanel table, table[data-table-view]';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    try {
        await page.evaluate(() => {
            const popups = document.querySelectorAll('.c-polite-pop-up--index, .s-popup, [class*="popup"], [id*="popup"], #iubenda-cs-banner, [class*="iubenda"]');
            popups.forEach(p => {
                const el = p;
                el.style.display = 'none';
                el.style.visibility = 'hidden';
                el.style.opacity = '0';
                el.style.pointerEvents = 'none';
            });
        });
    }
    catch {
        /* ignore */
    }
    try {
        const dropdownSelector = 'select#view, select.dropdown__select, select[name="view"]';
        const dropdown = await page.$(dropdownSelector);
        if (dropdown) {
            await page.selectOption(dropdownSelector, 'list');
            await page.waitForTimeout(1000);
        }
    }
    catch {
        /* ignore */
    }
    try {
        if (await page.$(tableToggleSelector)) {
            await page.click(tableToggleSelector, { timeout: 5000, force: true });
        }
    }
    catch {
        /* ignore */
    }
    try {
        await page.waitForSelector(tableSelectorConcrete, { timeout: 5000 });
    }
    catch {
        /* ignore */
    }
    await page.waitForTimeout(1500);
    for (let i = 0; i < 2; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(800);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);
    }
    const html = await page.content();
    await browser.close();
    const rawDir = path.resolve(__dirname, '../../../../data/raw');
    if (!fs.existsSync(rawDir))
        fs.mkdirSync(rawDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = alias.replace(/[^a-zA-Z0-9_-]/g, '_');
    const rawPath = path.join(rawDir, `${timestamp}_${slug}.html`);
    fs.writeFileSync(rawPath, html);
    return { html, rawPath };
};
const compare = () => {
    const [, , scheduleUrl, teamName, alias = 'compare'] = process.argv;
    if (!scheduleUrl || !teamName) {
        console.error('Usage: tsx compare_schedule_to_csv.ts <scheduleUrl> "<Team Name>" [alias]');
        process.exit(1);
    }
    (async () => {
        console.log(`Fetching HTML for ${teamName} ...`);
        const { html, rawPath } = await fetchHtmlLikeV2(scheduleUrl, alias);
        console.log(`Saved raw HTML to ${rawPath}`);
        const parser = new parsers_1.SidearmParser();
        const parsed = await parser.parseSchedule(html, { teamName, baseUrl: scheduleUrl, debug: true });
        console.log(`Parsed ${parsed.length} games from HTML.`);
        const year = parsed[0]?.date?.split('-')[0] || '2025';
        const csvGames = readCsvGames(year, teamName);
        console.log(`Loaded ${csvGames.length} games from games.csv for ${teamName}.`);
        const csvMap = new Map();
        for (const r of csvGames) {
            csvMap.set(normalizeKey(r.date, r.home_team_name, r.away_team_name), r);
        }
        const seenCsvKeys = new Set();
        for (const g of parsed) {
            const key = normalizeKey(g.date, g.home_team_name, g.away_team_name);
            const csvRow = csvMap.get(key);
            if (!csvRow) {
                console.log(`[MISSING_IN_CSV] ${g.date} ${g.home_team_name} vs ${g.away_team_name} status=${g.status} box=${g.source_urls?.boxscore_url || 'none'} score=${g.home_score ?? ''}-${g.away_score ?? ''}`);
                continue;
            }
            seenCsvKeys.add(key);
            const diffs = [];
            const parsedBox = resolveBoxscoreUrl(g.source_urls?.boxscore_url, scheduleUrl) || '';
            const csvBox = csvRow.boxscore_url || '';
            if (csvBox !== parsedBox && parsedBox)
                diffs.push(`boxscore mismatch csv='${csvBox}' parsed='${parsedBox}'`);
            const ps = `${g.home_score ?? ''}`;
            const pa = `${g.away_score ?? ''}`;
            const cs = `${csvRow.home_score || ''}`;
            const ca = `${csvRow.away_score || ''}`;
            if (ps !== cs || pa !== ca)
                diffs.push(`score mismatch csv=${cs}-${ca} parsed=${ps}-${pa}`);
            if (csvRow.status !== g.status)
                diffs.push(`status mismatch csv=${csvRow.status} parsed=${g.status}`);
            if (diffs.length === 0) {
                console.log(`[OK] ${g.date} ${g.home_team_name} vs ${g.away_team_name}`);
            }
            else {
                console.log(`[DIFF] ${g.date} ${g.home_team_name} vs ${g.away_team_name} :: ${diffs.join(' | ')}`);
            }
        }
        for (const [key, row] of csvMap.entries()) {
            if (!seenCsvKeys.has(key)) {
                console.log(`[CSV_ONLY] ${row.date} ${row.home_team_name} vs ${row.away_team_name} status=${row.status} box=${row.boxscore_url || 'none'} score=${row.home_score || ''}-${row.away_score || ''}`);
            }
        }
    })().catch(err => {
        console.error('compare_schedule_to_csv failed:', err);
        process.exit(1);
    });
};
compare();
//# sourceMappingURL=compare_schedule_to_csv.js.map