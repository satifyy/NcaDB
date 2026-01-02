
import * as fs from 'fs';
import * as path from 'path';
import { SidearmParser } from '@ncaa/parsers';

async function main() {
    console.log('Verifying SMU Schedule Parser...');

    // Use the actual file we found in data/raw
    const jsonPath = path.resolve(__dirname, '../../../../data/raw/2025-12-27T18-48-06-419Z_SMU_results_json.html');

    if (!fs.existsSync(jsonPath)) {
        console.error(`File not found: ${jsonPath}`);
        // Fallback to checking any json html file if specific one is missing, for robustness in dev
        const rawDir = path.resolve(__dirname, '../../../../data/raw');
        const files = fs.readdirSync(rawDir).filter(f => f.includes('SMU_results_json.html'));
        if (files.length === 0) {
            console.error("No SMU results json files found.");
            process.exit(1);
        }
        console.log(`Falling back to ${files[0]}`);
    }

    const content = fs.readFileSync(jsonPath, 'utf-8');
    const parser = new SidearmParser();

    console.log(`Parsing content from ${jsonPath}...`);
    try {
        const games = await parser.parseSchedule(content, { teamName: 'SMU' });
        console.log(`Successfully parsed ${games.length} games.`);

        if (games.length > 0) {
            console.log('Sample games:');
            // Show more games to verify different statuses
            games.forEach(g => {
                const score = (g.home_score !== null && g.away_score !== null)
                    ? `(${g.home_score}-${g.away_score})`
                    : '(vs)';
                console.log(`[${g.date}] ${g.home_team_name} vs ${g.away_team_name} ${score} [${g.location_type}] Status: ${g.status}`);
            });
        }
    } catch (e: any) {
        console.error('Parsing failed:', e);
    }
}

main();
