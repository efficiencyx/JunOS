const authScreen = document.getElementById('authScreen');
const authTabLogin = document.getElementById('authTabLogin');
const authTabSignup = document.getElementById('authTabSignup');
const authFormLogin = document.getElementById('authFormLogin');
const authFormSignup = document.getElementById('authFormSignup');
const signOutBtn = document.getElementById('signOutBtn');

function detectOS() {
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
    const btn = document.getElementById('signupBtn');
    btn.disabled = true;
    try {
      const r = await Auth.signup(email, password, adultConsent);
      if (r.ok) { location.reload(); return; }
      const j = await r.json().catch(() => ({}));
      const msgs = { email_taken: 'That email is already registered.', invalid_email: 'Invalid email address.', password_too_short: 'Password must be at least 8 characters.', adult_consent_required: 'You must confirm you are 18 or older.', rate_limit_exceeded: 'Too many attempts - wait a minute.' };
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
