// Run this once with Node.js to generate PNG icons:
//   node icons/generate-icons.js
//
// Requires the 'canvas' package:
//   npm install canvas  (or: npx --yes canvas)

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 48, 128];

for (const size of SIZES) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle — indigo gradient approximated with solid fill
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#4f46e5');
  grad.addColorStop(1, '#7c3aed');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Scale emoji — ⚖️ rendered as text
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(size * 0.58)}px serif`;
  ctx.fillText('⚖', size / 2, size / 2 + size * 0.03);

  const buffer = canvas.toBuffer('image/png');
  const outPath = path.join(__dirname, `icon${size}.png`);
  fs.writeFileSync(outPath, buffer);
  console.log(`✓ ${outPath}`);
}

console.log('Icons generated successfully.');
