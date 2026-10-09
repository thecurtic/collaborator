// Generates PWA/app icons from inline SVG sources using sharp.
// Run: node scripts/generate-icons.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Rounded-tile icon (for "any" purpose, favicon, apple-touch).
const anySvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <path fill="#fff" d="M150 140h212a40 40 0 0 1 40 40v120a40 40 0 0 1-40 40H236l-66 58a8 8 0 0 1-13-6v-52h-7a40 40 0 0 1-40-40V180a40 40 0 0 1 40-40z"/>
  <g fill="#3b82f6"><circle cx="196" cy="240" r="20"/><circle cx="256" cy="240" r="20"/><circle cx="316" cy="240" r="20"/></g>
</svg>`;

// Maskable icon: full-bleed background, mark kept inside the ~60% safe zone.
const maskableSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#3b82f6"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(106 106) scale(0.585)">
    <path fill="#fff" d="M150 140h212a40 40 0 0 1 40 40v120a40 40 0 0 1-40 40H236l-66 58a8 8 0 0 1-13-6v-52h-7a40 40 0 0 1-40-40V180a40 40 0 0 1 40-40z"/>
    <g fill="#3b82f6"><circle cx="196" cy="240" r="20"/><circle cx="256" cy="240" r="20"/><circle cx="316" cy="240" r="20"/></g>
  </g>
</svg>`;

const jobs = [
  { svg: anySvg, size: 192, out: 'pwa-192x192.png' },
  { svg: anySvg, size: 512, out: 'pwa-512x512.png' },
  { svg: maskableSvg, size: 512, out: 'maskable-512x512.png' },
  { svg: anySvg, size: 180, out: 'apple-touch-icon.png' },
  { svg: anySvg, size: 64, out: 'favicon-64.png' },
];

for (const { svg, size, out } of jobs) {
  const png = await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
  await writeFile(join(publicDir, out), png);
  console.log(`wrote public/${out} (${size}x${size})`);
}
