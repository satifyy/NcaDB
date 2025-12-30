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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const cheerio = __importStar(require("cheerio"));
const htmlPath = path_1.default.join(process.cwd(), 'unc_boxscore_page.html');
const html = fs_1.default.readFileSync(htmlPath, 'utf8');
const $ = cheerio.load(html);
let nuxtScript = '';
let found = false;
$('script').each((i, el) => {
    const content = $(el).html() || '';
    if (content.includes('Cordes') || content.includes('"boxscore"')) {
        nuxtScript = content;
        found = true;
        return false; // break
    }
});
if (found && nuxtScript) {
    fs_1.default.writeFileSync('nuxt_data_script.js', nuxtScript);
    console.log(`Extracted Nuxt data script. Length: ${nuxtScript.length}`);
    console.log('Start of script:', nuxtScript.substring(0, 200));
}
else {
    console.error('Nuxt data script not found');
}
//# sourceMappingURL=extract_nuxt_data_script.js.map