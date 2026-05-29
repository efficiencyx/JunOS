// Runs before the body renders (loaded as a blocking <script> in <head>).
// Externalized from an inline script so it passes the nginx CSP, which does
// not allow 'unsafe-inline' for script-src.

// Keep the app shell hidden until the session check resolves, so unlogged
// visitors never see the chat UI or the AI-provider boot overlay.
document.documentElement.setAttribute('data-pre-auth', '1');

if (localStorage.getItem('omega.adultConsent.v1') !== '1') {
  // First visit: the 18+ gate must come before anything else, including login.
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
