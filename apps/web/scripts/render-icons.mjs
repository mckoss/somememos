// Renders the app icons in static/icons/ from icon.svg's design, in the UI's
// accent colour (app.css `--accent`, light). Run after changing the design:
//
//   node apps/web/scripts/render-icons.mjs
//
// Uses the Chromium that Playwright drives, so it needs no image tooling.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ACCENT = '#2f5d9b';
const PAPER = '#ffffff';
const dir = fileURLToPath(new URL('../static/icons/', import.meta.url));

/** The note glyph on a 512 grid, scaled by `scale` about the centre. */
function glyph(scale = 1) {
  const t = `translate(256 256) scale(${scale}) translate(-256 -256)`;
  return `<g transform="${t}">
    <rect x="136" y="104" width="240" height="304" rx="28" fill="${PAPER}"/>
    <rect x="176" y="168" width="160" height="22" rx="11" fill="${ACCENT}"/>
    <rect x="176" y="226" width="160" height="22" rx="11" fill="${ACCENT}" opacity="0.7"/>
    <rect x="176" y="284" width="104" height="22" rx="11" fill="${ACCENT}" opacity="0.45"/>
  </g>`;
}

/** Rounded tile with transparent corners: the "any" icon. */
const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${ACCENT}"/>
  ${glyph()}
</svg>
`;

/** Full-bleed square, glyph inside the maskable safe zone (a centred 80% circle). */
const fullBleed = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${ACCENT}"/>
  ${glyph(scale)}
</svg>
`;

const outputs = [
  { file: 'icon-192.png', size: 192, svg: rounded, alpha: true },
  { file: 'icon-512.png', size: 512, svg: rounded, alpha: true },
  { file: 'favicon-32.png', size: 32, svg: rounded, alpha: true },
  { file: 'maskable-192.png', size: 192, svg: fullBleed(0.7), alpha: false },
  { file: 'maskable-512.png', size: 512, svg: fullBleed(0.7), alpha: false },
  { file: 'apple-touch-icon.png', size: 180, svg: fullBleed(0.85), alpha: false },
];

writeFileSync(`${dir}icon.svg`, rounded);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, svg, alpha } of outputs) {
    await page.setViewportSize({ width: size, height: size });
    const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}img{display:block}</style>` +
        `<img src="${url}" width="${size}" height="${size}">`,
    );
    await page.locator('img').evaluate((img) => img.decode());
    await page.screenshot({ path: `${dir}${file}`, omitBackground: alpha });
  }
} finally {
  await browser.close();
}
console.log(`Rendered ${outputs.length} icons into ${dir}`);
