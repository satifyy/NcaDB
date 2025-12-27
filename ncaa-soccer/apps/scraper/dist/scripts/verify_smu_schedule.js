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
const parsers_1 = require("@ncaa/parsers");
async function main() {
    console.log('Verifying SMU Schedule Parser...');
    const jsonPath = path.resolve(__dirname, '../../../../data/raw/2025-12-27T18-48-06-419Z_SMU_results_json.html');
    if (!fs.existsSync(jsonPath)) {
        console.error(`File not found: ${jsonPath}`);
        process.exit(1);
    }
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const parser = new parsers_1.SidearmParser();
    console.log(`Parsing content from ${jsonPath}...`);
    try {
        const games = await parser.parseSchedule(content, { teamName: 'SMU' });
        console.log(`Successfully parsed ${games.length} games.`);
        if (games.length > 0) {
            console.log('Sample games:');
            games.slice(0, 3).forEach(g => {
                console.log(`[${g.date}] ${g.home_team_name} vs ${g.away_team_name} (${g.home_score ?? '-'}-${g.away_score ?? '-'}) Status: ${g.status}`);
            });
        }
    }
    catch (e) {
        console.error('Parsing failed:', e);
    }
}
main();
//# sourceMappingURL=verify_smu_schedule.js.map