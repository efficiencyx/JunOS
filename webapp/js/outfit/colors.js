export function hexToRgb01(hex) {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

export function normalizeHex(value) {
  const raw = String(value || '').trim();
  const short = /^#?([0-9a-f]{3})$/i.exec(raw);
  if (short) return '#' + [...short[1]].map(c => c + c).join('').toLowerCase();
  const full = /^#?([0-9a-f]{6})$/i.exec(raw);
  return full ? '#' + full[1].toLowerCase() : null;
}

export function hexToHsv(hex) {
  const [r, g, b] = hexToRgb01(hex) || [1, 1, 1];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d && max === r) h = 60 * (((g - b) / d) % 6);
  else if (d && max === g) h = 60 * ((b - r) / d + 2);
  else if (d) h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return '#' + rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
}
