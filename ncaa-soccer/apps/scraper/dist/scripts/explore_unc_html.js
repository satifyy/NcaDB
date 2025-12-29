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
const cheerio = __importStar(require("cheerio"));
const htmlPath = path.resolve(__dirname, '../../../../data/raw/2025-12-27T07-14-57-340Z_UNC_schedule.html');
const debugPath = path.resolve(__dirname, 'debug_unc.txt');
const content = fs.readFileSync(htmlPath, 'utf-8');
const $ = cheerio.load(content);
const gameCards = $('.s-game-card');
let output = `Found ${gameCards.length} game cards.\n\n`;
if (gameCards.length > 0) {
    const firstCard = gameCards.first();
    output += '--- First Card HTML ---\n';
    output += firstCard.html() + '\n';
    output += '--- End HTML ---\n\n';
    output += '--- Text Content ---\n';
    output += firstCard.text().replace(/\s+/g, ' ') + '\n\n';
    // Check for specific commonly used classes
    const classes = new Set();
    firstCard.find('*').each((_, el) => {
        const classVal = $(el).attr('class');
        if (classVal) {
            classVal.split(' ').forEach(c => classes.add(c));
        }
    });
    output += '--- Classes Found ---\n';
    output += Array.from(classes).join(', ') + '\n';
}
fs.writeFileSync(debugPath, output);
console.log(`Wrote debug info to ${debugPath}`);
//# sourceMappingURL=explore_unc_html.js.map