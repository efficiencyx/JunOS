// not inline. the nginx CSP (Content-Security-Policy, the header
// that says what the page may run) has no 'unsafe-inline' in
// script-src, so this is a blocking <script> in <head> instead.

document.documentElement.setAttribute('data-pre-auth', '1');

// Done here and not with <link> tags so they don't block the parser. the
// pre-app screens are covered by the inlined critical CSS until these land.
for (const href of ['styles.css?v=82', 'css/trip-loader.css?v=1']) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

// same window chrome as the terminal on this OS. ?os= forces one.
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
function flavorTerminals() {
  const os = detectOS();
  const titles = { mac: 'jun - -zsh - 80×24', windows: 'Windows PowerShell', linux: 'jun@junbuntu: ~' };
  const bootTitles = { mac: 'jun - boot - 80×24', windows: 'Windows PowerShell', linux: 'jun@junbuntu: ~/boot' };
  const names = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };
  for (const term of document.querySelectorAll('.auth-term, .boot-term')) {
    term.setAttribute('data-os', os);
    const title = term.querySelector('.term-title');
    if (title) title.textContent = (term.classList.contains('boot-term') ? bootTitles : titles)[os];
    const name = term.querySelector('.auth-os-name');
    if (name) name.textContent = names[os];
  }
}

// The 18+ gate comes before Everything, login included.
const ageGated = localStorage.getItem('omega.adultConsent.v1') !== '1';
if (ageGated) document.documentElement.setAttribute('data-age-gated', '1');
document.addEventListener('DOMContentLoaded', () => {
  flavorTerminals();
  if (!ageGated) return;
  const gate = document.getElementById('ageGate');
  gate.hidden = false;
  document.getElementById('ageGateAccept').onclick = () => {
    localStorage.setItem('omega.adultConsent.v1', '1');
    gate.remove();
    document.documentElement.removeAttribute('data-age-gated');
  };
  document.getElementById('ageGateLeave').onclick = () => {
    window.location.href = 'https://www.google.com';
  };
});
