import { api, apiJson } from '../core/api.js?v=1';

export async function list() {
  const r = await api('conversations.php?action=list');
  if (!r.ok) throw new Error(`history list ${r.status}`);
  return r.json();
}

export async function create() {
  const r = await api('conversations.php?action=create', { method: 'POST' });
  if (!r.ok) throw new Error(`history create ${r.status}`);
  return r.json();
}

export async function load(id) {
  const r = await api(`conversations.php?action=messages&id=${id}`);
  if (!r.ok) throw new Error(`history load ${r.status}`);
  return r.json();
}

async function del(id) {
  const r = await api(`conversations.php?action=delete&id=${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`history delete ${r.status}`);
  return r.json();
}

export async function rename(id, title) {
  const r = await apiJson(`conversations.php?action=rename&id=${id}`, { title });
  if (!r.ok) throw new Error(`history rename ${r.status}`);
  return r.json();
}

export async function compact(id) {
  const r = await api(`conversations.php?action=compact&id=${id}`, { method: 'POST' });
  if (!r.ok) throw new Error(`history compact ${r.status}`);
  return r.json();
}

export { del as delete };
