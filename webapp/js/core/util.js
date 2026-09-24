import * as MobileViewport from './viewport.js?v=1';

export function formatElapsed(seconds) {
  const whole = Math.max(0, Math.round(seconds));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

export function phoneMode() {
  return MobileViewport.isPhone();
}

export function visualRect() {
  return MobileViewport.getVisualRect();
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

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// the date page and the dates panel both decide lunch or dinner
// off this, so they can't disagree about what time it is
export function mealNow() {
  return new Date().getHours() < 16 ? 'lunch' : 'dinner';
}
