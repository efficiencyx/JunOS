import { api, apiGet, apiJson } from '../core/api.js?v=1';

// MOD_PART_BYTES in api/lib/mods.php, MOD_MAX_PARTS of these is the zip cap
const PART = 4 * 1024 * 1024;
export const MAX_BYTES = 8 * PART;

const url = (guid, extra = '') => `mods.php?guid=${encodeURIComponent(guid)}${extra}`;

export const listRemote = () => apiGet('mods.php');

export async function fetchRemote(guid) {
  const r = await api(url(guid));
  return r.ok ? r.arrayBuffer() : null;
}

export async function uploadRemote(guid, buf) {
  if (buf.byteLength > MAX_BYTES) throw new Error('mod zip over 32 MB');
  const parts = Math.max(1, Math.ceil(buf.byteLength / PART));
  for (let part = 0; part < parts; part++) {
    const r = await api(url(guid, `&part=${part}&parts=${parts}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf.slice(part * PART, (part + 1) * PART),
    });
    if (!r.ok) throw new Error(`mod upload failed: ${r.status}`);
  }
}

export const deleteRemote = (guid) => api(url(guid), { method: 'DELETE' }).catch(() => { });

export async function saveRemoteState(doc, keepalive = false) {
  try {
    const r = await apiJson('mods.php?action=state', doc, { method: 'PUT', keepalive });
    return r.ok ? (await r.json()).version : null;
  } catch {
    return null;
  }
}
