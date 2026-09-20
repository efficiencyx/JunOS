const authScreen = document.getElementById('authScreen');
const authTabLogin = document.getElementById('authTabLogin');
const authTabSignup = document.getElementById('authTabSignup');
const authFormLogin = document.getElementById('authFormLogin');
const authFormSignup = document.getElementById('authFormSignup');
const authFormRecover = document.getElementById('authFormRecover');
const authRecoveryCode = document.getElementById('authRecoveryCode');
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

// a server with no key set never mentions one, so the field only
// shows up where it's actually needed. if the probe fails we
// leave it hidden and let the signup call come back with
// registration_closed.
async function revealRegKeyField() {
  const field = document.getElementById('signupRegKeyField');
  if (!field) return;
  try {
    const r = await fetch('/api/auth.php?action=signup_info', { credentials: 'same-origin' });
    if (!r.ok) return;
    const info = await r.json();
    if (info && info.registration_key_required) field.hidden = false;
  } catch {}
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

// the recovery code comes back exactly once, on signup and on the
// first login of an account that predates encrypted rows. the
// reload that would normally follow waits until he says he saved it.
function showRecoveryCode(code) {
  if (!authRecoveryCode || !code) { location.reload(); return; }
  document.getElementById('authRecoveryCodeValue').textContent = code;
  for (const el of [authFormLogin, authFormSignup, authFormRecover]) if (el) el.hidden = true;
  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.style.display = 'none';
  authRecoveryCode.hidden = false;
}
document.getElementById('authRecoveryDone')?.addEventListener('click', () => location.reload());

document.getElementById('authShowRecover')?.addEventListener('click', () => {
  authFormLogin.hidden = true;
  authFormRecover.hidden = false;
});
document.getElementById('authHideRecover')?.addEventListener('click', () => {
  authFormRecover.hidden = true;
  authFormLogin.hidden = false;
});

if (authFormRecover) {
  authFormRecover.addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError('recoverError', '');
    const email = document.getElementById('recoverEmail').value.trim();
    const code = document.getElementById('recoverCode').value.trim();
    const password = document.getElementById('recoverPassword').value;
    const btn = document.getElementById('recoverBtn');
    btn.disabled = true;
    try {
      const r = await Auth.recover(email, code, password);
      if (r.ok) { location.reload(); return; }
      const j = await r.json().catch(() => ({}));
      const msgs = { invalid_recovery_code: 'That email and recovery code do not match.', password_too_short: 'Password must be at least 8 characters.', rate_limit_exceeded: 'Too many attempts - try again in an hour.' };
      setAuthError('recoverError', msgs[j.error] || 'Recovery failed.');
    } catch { setAuthError('recoverError', 'Network error.'); }
    btn.disabled = false;
  });
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
      const j = await r.json().catch(() => ({}));
      if (r.ok) { j.recovery_code ? showRecoveryCode(j.recovery_code) : location.reload(); return; }
      const msgs = { invalid_credentials: 'Wrong email or password.', rate_limit_exceeded: 'Too many attempts - wait a minute.', data_key_unavailable: 'Your data key would not open. Use your recovery code.' };
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
      const j = await r.json().catch(() => ({}));
      if (r.ok) { showRecoveryCode(j.recovery_code); return; }
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
