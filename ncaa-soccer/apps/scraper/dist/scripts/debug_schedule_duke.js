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
const playwright_chromium_1 = require("playwright-chromium");
const fs = __importStar(require("fs"));
async function main() {
    const url = 'https://goduke.com/sports/mens-soccer/schedule';
    console.log(`Debugging ${url}...`);
    const browser = await playwright_chromium_1.chromium.launch({ headless: true }); // Headless false to see what's happening if needed
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
    }
    else {
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
//# sourceMappingURL=debug_schedule_duke.js.map