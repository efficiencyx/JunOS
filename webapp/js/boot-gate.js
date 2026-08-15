// Not inline. the nginx CSP has no 'unsafe-inline' for script-src, so this is
// a blocking <script> in <head> instead.

document.documentElement.setAttribute('data-pre-auth', '1');

// Done here and not with <link> tags so they don't block the parser. the
// pre-app screens are covered by the inlined critical CSS until these land.
for (const href of ['styles.css?v=2', 'trip-loader.css?v=2']) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

// The 18+ gate comes before Everything, login included.
if (localStorage.getItem('omega.adultConsent.v1') !== '1') {
  document.documentElement.setAttribute('data-age-gated', '1');
  document.addEventListener('DOMContentLoaded', () => {
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
}
