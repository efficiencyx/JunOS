export function formatElapsed(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

export function phoneMode() {
  return !!(window.MobileViewport && MobileViewport.isPhone());
}

export function visualRect() {
  if (window.MobileViewport && MobileViewport.getVisualRect) return MobileViewport.getVisualRect();
  return { left: 0, top: 0, width: innerWidth, height: innerHeight, right: innerWidth, bottom: innerHeight };
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

export function localTimeString() {
  try {
    return new Date().toLocaleString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  } catch (e) {
    return new Date().toString();
  }
}
