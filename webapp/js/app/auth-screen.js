const authScreen = document.getElementById('authScreen');
const authTabLogin = document.getElementById('authTabLogin');
const authTabSignup = document.getElementById('authTabSignup');
const authFormLogin = document.getElementById('authFormLogin');
const authFormSignup = document.getElementById('authFormSignup');
const signOutBtn = document.getElementById('signOutBtn');

function detectOS() {
  const forced = new URLSearchParams(location.search).get('os');
  if (forced === 'mac' || forced === 'windows' || forced === 'linux') return forced;
  const p = (navigator.userAgentData && navigator.userAgentData.platform)
    || navigator.platform || navigator.userAgent || '';
  const s = p.toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(s)) return 'mac';
  if (/win/.test(s)) return 'windows';
  return 'linux';
}
(function flavorTerminals() {
  const os = detectOS();
  const authTitles = { mac: 'jun - -zsh - 80×24', windows: 'Windows PowerShell', linux: 'jun@junbuntu: ~' };
  const bootTitles = { mac: 'jun - boot - 80×24', windows: 'Windows PowerShell', linux: 'jun@junbuntu: ~/boot' };
  const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

  const authTerm = document.getElementById('authTerm');
  if (authTerm) {
    authTerm.setAttribute('data-os', os);
    const t = document.getElementById('authTermTitle');
    if (t) t.textContent = authTitles[os];
    const n = authTerm.querySelector('.auth-os-name');
    if (n) n.textContent = names[os];
  }

  const bootTerm = document.querySelector('.boot-term');
  if (bootTerm) {
    bootTerm.setAttribute('data-os', os);
    const bt = bootTerm.querySelector('.term-title');
    if (bt) bt.textContent = bootTitles[os];
  }
})();

export function showAuthScreen() {
  if (authScreen) authScreen.hidden = false;
  const bo = document.getElementById('bootOverlay');
  if (bo) {
    bo.setAttribute('data-ready', '1');
    bo.setAttribute('aria-hidden', 'true');
  }
  revealRegKeyField();
}

// A server with no key set never mentions one, so the field only appears
// where it is actually needed. if the probe fails we leave it hidden and
// let the signup call come back with registration_closed.
async function revealRegKeyField() {
  const field = document.getElementById('signupRegKeyField');
  if (!field) return;
  try {
    const r = await fetch('/api/auth.php?action=signup_info', { credentials: 'same-origin' });
    if (!r.ok) return;
    const info = await r.json();
    if (info && info.registration_key_required) field.hidden = false;
  } catch { /* offline: the field stays hidden */ }
}

function hideAuthScreen() {
  if (authScreen) authScreen.hidden = true;
}

if (authTabLogin && authTabSignup) {
  authTabLogin.addEventListener('click', () => {
    authTabLogin.classList.add('active');
    authTabLogin.setAttribute('aria-selected', 'true');
    authTabSignup.classList.remove('active');
    authTabSignup.setAttribute('aria-selected', 'false');
    authFormLogin.hidden = false;
    authFormSignup.hidden = true;
  });
  authTabSignup.addEventListener('click', () => {
    authTabSignup.classList.add('active');
    authTabSignup.setAttribute('aria-selected', 'true');
    authTabLogin.classList.remove('active');
    authTabLogin.setAttribute('aria-selected', 'false');
    authFormSignup.hidden = false;
    authFormLogin.hidden = true;
  });
}

function setAuthError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.hidden = true; el.textContent = ''; }
}

if (authFormLogin) {
  authFormLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError('loginError', '');
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    try {
      const r = await Auth.login(email, password);
      if (r.ok) { location.reload(); return; }
      const j = await r.json().catch(() => ({}));
      const msgs = { invalid_credentials: 'Wrong email or password.', rate_limit_exceeded: 'Too many attempts - wait a minute.' };
      setAuthError('loginError', msgs[j.error] || 'Login failed.');
    } catch { setAuthError('loginError', 'Network error.'); }
    btn.disabled = false;
  });
}

if (authFormSignup) {
  authFormSignup.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError('signupError', '');
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const adultConsent = document.getElementById('signupAdult').checked;
    const regKey = (document.getElementById('signupRegKey')?.value || '').trim();
    const btn = document.getElementById('signupBtn');
    btn.disabled = true;
    try {
      const r = await Auth.signup(email, password, adultConsent, regKey);
      if (r.ok) { location.reload(); return; }
      const j = await r.json().catch(() => ({}));
      const msgs = { email_taken: 'That email is already registered.', invalid_email: 'Invalid email address.', password_too_short: 'Password must be at least 8 characters.', adult_consent_required: 'You must confirm you are 18 or older.', registration_closed: 'Sign-ups on this server need a registration key.', invalid_registration_key: 'Wrong registration key.', rate_limit_exceeded: 'Too many attempts - wait a minute.' };
      if (j.error === 'registration_closed') {
        const field = document.getElementById('signupRegKeyField');
        if (field) field.hidden = false;
      }
      setAuthError('signupError', msgs[j.error] || 'Sign up failed.');
    } catch { setAuthError('signupError', 'Network error.'); }
    btn.disabled = false;
  });
}

if (signOutBtn) {
  signOutBtn.addEventListener('click', async () => {
    if (window.Prefs) Prefs.clearLocal();
    await Auth.logout();
    location.reload();
  });
}
