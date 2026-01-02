import { chromium } from 'playwright-chromium';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
    const url = 'https://goduke.com/sports/mens-soccer/schedule';
    console.log(`Debugging ${url}...`);

    const browser = await chromium.launch({ headless: true }); // Headless false to see what's happening if needed
    const page = await browser.newPage({
        viewport: { width: 1280, height: 800 }
    });

    await page.goto(url, { waitUntil: 'networkidle' });

    // Check for Table View Toggle
    const tableSelector = '#_viewType_table, button[aria-label="Table View"], .sidearm-schedule-view-options button:has-text("Table")';
    const toggle = await page.$(tableSelector);
    if (toggle) {
        console.log('Found Table View toggle. Clicking...');
        await toggle.click();
        await page.waitForTimeout(1000);
    } else {
        console.log('No Table View toggle found.');
    }

    // Capture HTML
    const html = await page.content();
    fs.writeFileSync('debug_duke_schedule.html', html);
    console.log('Saved debug_duke_schedule.html');

    // Check for "Links" buttons
    const linkButtons = await page.$$('button[aria-label*="Links" i], button:has-text("Links")');
    console.log(`Found ${linkButtons.length} "Links" buttons.`);

    if (linkButtons.length > 0) {
        // Try clicking one
        console.log('Clicking the first link button to see what pops up...');
        await linkButtons[0].click();
        await page.waitForTimeout(500);
        const htmlAfterClick = await page.content();
        fs.writeFileSync('debug_duke_schedule_clicked.html', htmlAfterClick);
    }

    await browser.close();
}

main().catch(console.error);
