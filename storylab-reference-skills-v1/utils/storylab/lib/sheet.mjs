import {readFileSync, writeFileSync} from 'node:fs';
import {extname} from 'node:path';

const MIMES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};
const escapeXml = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[character]));

export function contactSheetSvg(plan, outputs) {
  const columns = plan.sheet_columns;
  const tileWidth = 480;
  const imageHeight = plan.aspect_ratio === '16:9' ? 270 : plan.aspect_ratio === '1:1' ? 480 : 620;
  const tileHeight = imageHeight + 72;
  const headerHeight = 116;
  const rows = Math.ceil(outputs.length / columns);
  const width = tileWidth * columns;
  const height = headerHeight + tileHeight * rows;
  const tiles = outputs.map((output, index) => {
    const x = index % columns * tileWidth;
    const y = headerHeight + Math.floor(index / columns) * tileHeight;
    const mime = MIMES[extname(output.image_file).toLowerCase()];
    const data = readFileSync(output.image_file).toString('base64');
    return `<g transform="translate(${x} ${y})">
  <rect width="${tileWidth}" height="${tileHeight}" fill="#111318" stroke="#343942"/>
  <image x="12" y="12" width="456" height="${imageHeight - 24}" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${data}"/>
  <text x="20" y="${imageHeight + 28}" fill="#f5f6f8" font-family="ui-sans-serif, system-ui, sans-serif" font-size="19" font-weight="650">${escapeXml(output.label)}</text>
  <text x="20" y="${imageHeight + 52}" fill="#9ea6b2" font-family="ui-monospace, monospace" font-size="13">seed ${output.seed} · ${escapeXml(output.view_id)}</text>
</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#0b0d10"/>
<text x="24" y="42" fill="#ffffff" font-family="ui-sans-serif, system-ui, sans-serif" font-size="28" font-weight="700">${escapeXml(plan.asset_id)} · ${escapeXml(plan.kind)}</text>
<text x="24" y="72" fill="#aeb5c0" font-family="ui-monospace, monospace" font-size="14">plan ${escapeXml(plan.plan_sha256.slice(0, 16))} · ${escapeXml(plan.aspect_ratio)} · ${outputs.length} views</text>
<text x="24" y="96" fill="#737d8c" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13">Generated views are references, not proof of real-world dimensions or identity.</text>
${tiles}
</svg>\n`;
}

export function writeContactSheet(file, plan, outputs) {
  writeFileSync(file, contactSheetSvg(plan, outputs), {flag: 'wx', mode: 0o600});
}

