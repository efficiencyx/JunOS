// service workers only register in a secure context, so over plain
// http to a LAN IP this is a no-op. same rule that gates mic capture
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js?v=1').catch(() => {});
  });
}
