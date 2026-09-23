import * as Live2D from '../live2d/live2d.js?v=4';
import { GLASSES_STYLES, VARIANTS } from './catalog.js?v=1';
import { availableAssets, textureAvailable } from './sync.js?v=3';
import { colors, variantState } from './current.js?v=1';
import { hexToRgb01 } from './colors.js?v=1';

const textureImgCache = {};

const textureImg = (url) => textureImgCache[url] || (textureImgCache[url] = new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = url;
}).catch((e) => { delete textureImgCache[url]; throw e; }));

function tintedLayer(img, hex) {
  if (!hex) return img;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(img, 0, 0);
  return c;
}

function duotoneLayer(img, mainHex, accentHex) {
  if (!accentHex) return tintedLayer(img, mainHex);
  const main = hexToRgb01(mainHex || '#ffffff').map(value => value * 255);
  const accent = hexToRgb01(accentHex).map(value => value * 255);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, c.width, c.height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const light = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
    data[i] = accent[0] + (main[0] - accent[0]) * light;
    data[i + 1] = accent[1] + (main[1] - accent[1]) * light;
    data[i + 2] = accent[2] + (main[2] - accent[2]) * light;
  }
  ctx.putImageData(pixels, 0, 0);
  return c;
}

export function stockingColorMode() {
  const variant = VARIANTS.find(v => v.key === 'sock_style');
  return variant.options[variantState.sock_style || 0].colorMode || null;
}

let stockingsJob = 0;

export function cancelStockingTexture() { stockingsJob++; }

export async function applyStockingTexture() {
  const index = variantState.sock_style || 0;
  const variant = VARIANTS.find(v => v.key === 'sock_style');
  const opt = variant.options[index];
  const mode = opt.colorMode;
  if (!mode) return;
  const entries = Object.entries(opt.textures || {}).filter(([, texture]) => textureAvailable(texture));
  const job = ++stockingsJob;
  if (entries.length !== variant.drawables.length) {
    Live2D.setDrawableTextures(Object.fromEntries(variant.drawables.map(drawable => [drawable, null])));
    return;
  }
  let loaded;
  try {
    loaded = await Promise.all(entries.map(async ([drawable, texture]) => {
      const url = typeof texture === 'object' ? texture.url : texture;
      return [drawable, url, await textureImg(url)];
    }));
  } catch (e) {
    if (job === stockingsJob) setTimeout(applyStockingTexture, 1000);
    return;
  }
  if (job !== stockingsJob || (variantState.sock_style || 0) !== index) return;
  const main = colors.stockings;
  const accent = colors.stockings_accent;
  const map = {};
  for (const [drawable, url, img] of loaded) {
    if (mode === 'overlay') {
      map[drawable] = {
        img: tintedLayer(img, accent),
        key: `${url}|${main || ''}|${accent || ''}`,
        overlay: true,
        baseTint: main,
      };
    } else {
      map[drawable] = {
        img: duotoneLayer(img, main, accent),
        key: `${url}|${main || ''}|${accent || ''}`,
      };
    }
  }
  await Live2D.setDrawableTextures(map);
  if (job !== stockingsJob || (variantState.sock_style || 0) !== index) return;
  for (const drawable of variant.drawables) Live2D.setDrawableTint(drawable, null);
}

let glassesJob = 0;

export async function applyGlassesTexture() {
  const style = GLASSES_STYLES[variantState.glasses_style || 0];
  if (!style) return;
  if (style.layers.some(([part]) =>
    !availableAssets.has(`variants/glasses/${style.base}_${part}.png`))) return;
  const job = ++glassesJob;
  let imgs;
  try {
    imgs = await Promise.all(style.layers.map(([part]) =>
      textureImg(`assets/variants/glasses/${style.base}_${part}.png`)));
  } catch (e) {
    // a dropped load leaves the raw ModdableFace atlas art on screen,
    // so retry instead of giving up for the rest of the session
    console.warn('glasses layer load failed, retrying', e);
    if (job === glassesJob) setTimeout(applyGlassesTexture, 1000);
    return;
  }
  if (job !== glassesJob || GLASSES_STYLES[variantState.glasses_style || 0] !== style) return;
  const c = document.createElement('canvas');
  c.width = imgs[0].width; c.height = imgs[0].height;
  const ctx = c.getContext('2d');
  style.layers.forEach(([, colorKey], i) => {
    ctx.drawImage(tintedLayer(imgs[i], colorKey && colors[colorKey]), 0, 0);
  });
  Live2D.setDrawableTextures({ ModdableFace: { url: c.toDataURL(), fullClear: true } });
}
