// API wrapper for /api/conversations.php

window.History = (function () {
  const API = 'api/conversations.php';

  async function list() {
    const r = await fetch(`${API}?action=list`);
    if (!r.ok) throw new Error(`history list ${r.status}`);
    return r.json();
  }

  async function create() {
    const r = await fetch(`${API}?action=create`, { method: 'POST' });
    if (!r.ok) throw new Error(`history create ${r.status}`);
    return r.json(); // {id}
  }

  async function load(id) {
    const r = await fetch(`${API}?action=messages&id=${id}`);
    if (!r.ok) throw new Error(`history load ${r.status}`);
    return r.json(); // [{role, content, created_at}]
  }

  async function del(id) {
    const r = await fetch(`${API}?action=delete&id=${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`history delete ${r.status}`);
    return r.json();
  }

  async function rename(id, title) {
    const r = await fetch(`${API}?action=rename&id=${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!r.ok) throw new Error(`history rename ${r.status}`);
    return r.json();
  }

  return { list, create, load, delete: del, rename };
})();
