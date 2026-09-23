// every call to webapp/api/*.php goes through here. relative on
// purpose, every page sits at the webapp root.
export function api(path, init = {}) {
  return fetch('api/' + path, { credentials: 'same-origin', ...init });
}

export function apiJson(path, body, init = {}) {
  return api(path, {
    method: 'POST',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
  });
}

// GET and parse, null on any failure. for callers that just fall
// back to a default when the server has nothing
export async function apiGet(path) {
  try {
    const r = await api(path);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
