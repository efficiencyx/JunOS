window.Auth = {
  me: () => fetch('/api/auth.php?action=me', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null),
  signup: (email, password, adult_consent) =>
    fetch('/api/auth.php?action=signup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, adult_consent }),
    }),
  login: (email, password) =>
    fetch('/api/auth.php?action=login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  logout: () => fetch('/api/auth.php?action=logout', { method: 'POST', credentials: 'same-origin' }),
};
