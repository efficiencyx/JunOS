// mod archives get read and drawn in the browser. we Never run
// the Lua.

const ZIP_MAX_BYTES = 256 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 2048;
const ZIP_MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function zipPath(name) {
  if (!name || name.length > 512 || name.includes('\\') || name.includes('\0') || name.startsWith('/')) {
    throw new Error('Unsafe path in mod archive');
  }
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe path in mod archive');
  return parts.join('/');
}

async function inflateEntry(data, expectedSize) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ZIP_MAX_ENTRY_BYTES || size > expectedSize) {
      await reader.cancel();
      throw new Error('Expanded mod file is too large');
    }
    chunks.push(value);
  }
  if (size !== expectedSize) throw new Error('Corrupt mod archive');
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function unzip(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 22 || buf.byteLength > ZIP_MAX_BYTES) {
    throw new Error('Mod archive is empty or too large');
  }
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  const centralSize = dv.getUint32(eocd + 12, true);
  const centralOffset = dv.getUint32(eocd + 16, true);
  if (dv.getUint16(eocd + 4, true) !== 0 || dv.getUint16(eocd + 6, true) !== 0 ||
      count > ZIP_MAX_ENTRIES || centralOffset + centralSize > eocd) {
    throw new Error('Unsupported or malformed mod archive');
  }
  let off = centralOffset;
  const entries = [];
  const names = new Set();
  let totalSize = 0;
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.byteLength || dv.getUint32(off, true) !== 0x02014b50) {
      throw new Error('Corrupt mod archive');
    }
    const flags = dv.getUint16(off + 8, true);
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const usize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const next = off + 46 + nameLen + extraLen + cmtLen;
    if (next > buf.byteLength || flags & 1) throw new Error('Encrypted or corrupt mod archive');
    const rawName = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
    if (rawName.endsWith('/')) { off = next; continue; }
    const name = zipPath(rawName);
    if (names.has(name)) throw new Error('Duplicate path in mod archive');
    names.add(name);
    if (method !== 0 && method !== 8) throw new Error('Unsupported compression in mod archive');
    // flat-colour PNGs and JSON can compress 500:1, so a ratio
    // check would flag real mods. the zip bomb limits (tiny zip,
    // gigabytes once inflated) are ZIP_MAX_ENTRY_BYTES and
    // ZIP_MAX_TOTAL_BYTES instead. inflateEntry stops at the
    // declared usize.
    if (usize > ZIP_MAX_ENTRY_BYTES) throw new Error('Expanded mod file is too large');
    totalSize += usize;
    if (totalSize > ZIP_MAX_TOTAL_BYTES) throw new Error('Expanded mod archive is too large');
    if (lho + 30 > buf.byteLength || dv.getUint32(lho, true) !== 0x04034b50) {
      throw new Error('Corrupt mod archive');
    }
    // the local header has its own name and extra lengths, data
    // comes right after them
    const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true);
    const dataOffset = lho + 30 + lnl + lel;
    if (dataOffset > buf.byteLength || csize > buf.byteLength - dataOffset) throw new Error('Corrupt mod archive');
    if (method === 0 && csize !== usize) throw new Error('Corrupt mod archive');
    entries.push({ name, method, usize, data: u8.subarray(dataOffset, dataOffset + csize) });
    off = next;
  }
  if (off !== centralOffset + centralSize) throw new Error('Corrupt mod archive');
  const out = Object.create(null);
  for (const entry of entries) {
    out[entry.name] = entry.method === 0 ? entry.data.slice() : await inflateEntry(entry.data, entry.usize);
  }
  return out;
}
