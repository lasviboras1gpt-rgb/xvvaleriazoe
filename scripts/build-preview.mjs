// Genera public/og-image.jpg: la imagen del sobre cerrado que se ve en WhatsApp.
// Uso: levantar el servidor local (npm run dev) y luego: node scripts/build-preview.mjs
import fs from 'node:fs';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { ({ chromium } = await import('/opt/npm-tools/node_modules/playwright/index.mjs')); }

const base = process.env.BASE || 'http://localhost:8888';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(`${base}/invite.html?og=1`);
await page.waitForSelector('html[data-ready="1"]');
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1200);
// congela animaciones para una imagen limpia
await page.addStyleTag({ content: '*{animation:none!important;transition:none!important}.stage-lilies{opacity:.5}' });
await page.waitForTimeout(200);
await page.screenshot({ path: 'public/og-image.jpg', type: 'jpeg', quality: 86 });
await browser.close();
console.log('public/og-image.jpg', (fs.statSync('public/og-image.jpg').size / 1024).toFixed(0) + ' KB');
