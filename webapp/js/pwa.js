// Service workers only register on a secure context, so this is a no-op over
// plain http to a LAN IP - same constraint that gates mic capture.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js?v=1').catch(() => {});
  });
}
