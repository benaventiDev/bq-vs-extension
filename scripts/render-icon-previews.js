const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const OUT_DIR = path.join(__dirname, '..', 'media', 'previews');
fs.mkdirSync(OUT_DIR, { recursive: true });

const palettes = {
  bqblue: {
    label: 'BigQuery blue',
    rim: '#1967D2',
    bar: '#4285F4',
    highlight: '#1967D2',
    glass: 'rgba(66, 133, 244, 0.10)',
    bg: '#FFFFFF',
  },
  mono: {
    label: 'Monochrome navy',
    rim: '#0F2A5C',
    bar: '#0F2A5C',
    highlight: '#0F2A5C',
    glass: 'rgba(15, 42, 92, 0.08)',
    bg: '#FFFFFF',
  },
  amber: {
    label: 'Blue + amber',
    rim: '#1967D2',
    bar: '#F9AB00',
    highlight: '#E37400',
    glass: 'rgba(25, 103, 210, 0.08)',
    bg: '#FFFFFF',
  },
};

const compositions = {
  A: {
    label: 'Magnifier over histogram',
    svg: (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<line x1="148" y1="106" x2="208" y2="166" stroke="${p.rim}" stroke-width="18" stroke-linecap="round"/>
  <circle cx="112" cy="70" r="44" fill="${p.glass}" stroke="${p.rim}" stroke-width="13"/>
  <rect x="40" y="200" width="22" height="38" fill="${p.bar}" rx="3"/>
  <rect x="70" y="170" width="22" height="68" fill="${p.bar}" rx="3"/>
  <rect x="100" y="186" width="22" height="52" fill="${p.bar}" rx="3"/>
  <rect x="130" y="150" width="22" height="88" fill="${p.bar}" rx="3"/>
  <rect x="160" y="180" width="22" height="58" fill="${p.bar}" rx="3"/>
  <rect x="190" y="200" width="22" height="38" fill="${p.bar}" rx="3"/>
</svg>`,
  },
  B: {
    label: 'Histogram inside lens',
    svg: (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs>
    <clipPath id="lensB">
      <circle cx="110" cy="110" r="72"/>
    </clipPath>
  </defs>
  <line x1="178" y1="178" x2="228" y2="228" stroke="${p.rim}" stroke-width="20" stroke-linecap="round"/>
  <circle cx="110" cy="110" r="78" fill="${p.glass}" stroke="${p.rim}" stroke-width="14"/>
  <g clip-path="url(#lensB)">
    <rect x="56"  y="132" width="14" height="44" fill="${p.bar}" rx="2"/>
    <rect x="76"  y="108" width="14" height="68" fill="${p.bar}" rx="2"/>
    <rect x="96"  y="124" width="14" height="52" fill="${p.bar}" rx="2"/>
    <rect x="116" y="92"  width="14" height="84" fill="${p.highlight}" rx="2"/>
    <rect x="136" y="116" width="14" height="60" fill="${p.bar}" rx="2"/>
    <rect x="156" y="132" width="14" height="44" fill="${p.bar}" rx="2"/>
  </g>
</svg>`,
  },
  C: {
    label: 'Magnifier on a bar',
    svg: (p) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<rect x="28"  y="196" width="24" height="44" fill="${p.bar}" rx="3"/>
  <rect x="60"  y="170" width="24" height="70" fill="${p.bar}" rx="3"/>
  <rect x="92"  y="184" width="24" height="56" fill="${p.bar}" rx="3"/>
  <rect x="124" y="136" width="24" height="104" fill="${p.highlight}" rx="3"/>
  <rect x="156" y="172" width="24" height="68" fill="${p.bar}" rx="3"/>
  <rect x="188" y="190" width="24" height="50" fill="${p.bar}" rx="3"/>
  <line x1="160" y1="100" x2="148" y2="122" stroke="${p.rim}" stroke-width="13" stroke-linecap="round"/>
  <circle cx="136" cy="76" r="36" fill="${p.glass}" stroke="${p.rim}" stroke-width="12"/>
</svg>`,
  },
};

const results = [];
for (const [compKey, comp] of Object.entries(compositions)) {
  for (const [palKey, pal] of Object.entries(palettes)) {
    const svg = comp.svg(pal);
    const base = `icon-${compKey}-${palKey}`;
    const svgPath = path.join(OUT_DIR, `${base}.svg`);
    const pngPath = path.join(OUT_DIR, `${base}.png`);
    fs.writeFileSync(svgPath, svg, 'utf8');
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } });
    const png = resvg.render().asPng();
    fs.writeFileSync(pngPath, png);
    results.push({ comp: compKey, pal: palKey, compLabel: comp.label, palLabel: pal.label, png: `${base}.png`, svg: `${base}.svg` });
  }
}

const cells = results.map((r) => `
    <div class="cell">
      <div class="thumb"><img src="${r.png}" alt="${r.comp}-${r.pal}"/></div>
      <div class="caption"><strong>${r.comp}-${r.pal}</strong><br/>${r.compLabel}<br/><span class="palette">${r.palLabel}</span></div>
    </div>`).join('');

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>Icon previews</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; background: #f5f5f7; padding: 24px; color: #222; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; max-width: 900px; }
  .cell { background: white; padding: 16px; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); text-align: center; }
  .thumb { width: 128px; height: 128px; margin: 0 auto; display: flex; align-items: center; justify-content: center; background: #fafafa; border-radius: 8px; }
  .thumb img { width: 128px; height: 128px; image-rendering: -webkit-optimize-contrast; }
  .caption { margin-top: 12px; font-size: 13px; line-height: 1.4; }
  .palette { color: #888; }
  .legend { margin-bottom: 16px; font-size: 13px; color: #555; }
</style></head>
<body>
  <h1>BigQuery Runner — icon previews</h1>
  <div class="legend">9 variants: 3 compositions (A / B / C) × 3 palettes (bqblue / mono / amber). Each rendered at 128×128 (final icon is 256×256).</div>
  <div class="grid">${cells}</div>
</body></html>`;

fs.writeFileSync(path.join(OUT_DIR, 'preview.html'), html, 'utf8');

console.log(`Wrote ${results.length} SVG+PNG pairs and preview.html to ${OUT_DIR}`);
for (const r of results) console.log(`  ${r.png}  (${r.compLabel} / ${r.palLabel})`);
