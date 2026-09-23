export const messages = [];
export let currentConversationId = null;
export let abortFn = null;
export let stopActiveStream = null;
export let renderVoiceDraft = null;
export let DevHud = null;

export function setCurrentConversationId(id) { currentConversationId = id; }
export function setAbortFn(fn) { abortFn = fn; }
export function setStopActiveStream(fn) { stopActiveStream = fn; }
export function setRenderVoiceDraft(fn) { renderVoiceDraft = fn; }
export function setDevHud(mod) { DevHud = mod; }
