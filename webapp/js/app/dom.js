export const messagesEl = document.getElementById('messages');
export const chatInput = document.getElementById('chatInput');
export const sendBtn = document.getElementById('sendBtn');
export const modelSelect = document.getElementById('modelSelect');
export const reasoningSelect = document.getElementById('reasoningSelect');
export const thinkChk = document.getElementById('thinkChk');
export const devNoIdleChk = document.getElementById('devNoIdleChk');
export const reloadPromptBtn = document.getElementById('reloadPromptBtn');
export const actionLogEl = document.getElementById('actionLog');
export const actionLogCount = document.getElementById('actionLogCount');
export const missingParamsEl = document.getElementById('missingParams');
export const rawStreamEl = document.getElementById('rawStream');
export const clearRawBtn = document.getElementById('clearRawBtn');
export const toolLogEl = document.getElementById('toolLog');
export const toolLogCount = document.getElementById('toolLogCount');
export const clearToolLogBtn = document.getElementById('clearToolLogBtn');
export const debugSystemPromptEl = document.getElementById('debugSystemPrompt');
export const consolidationBanner = document.getElementById('consolidationBanner');
export const consolidationTitle = document.getElementById('consolidationTitle');
export const consolidationSub = document.getElementById('consolidationSub');
export const moodInputs = {
  affection: document.getElementById('moodAffection'),
  trust: document.getElementById('moodTrust'),
  tension: document.getElementById('moodTension'),
};
export const moodVals = {
  affection: document.getElementById('moodAffectionVal'),
  trust: document.getElementById('moodTrustVal'),
  tension: document.getElementById('moodTensionVal'),
};
export const moodPhrases = {
  affection: document.getElementById('moodAffectionPhrase'),
  trust: document.getElementById('moodTrustPhrase'),
  tension: document.getElementById('moodTensionPhrase'),
};
export const moodRefreshBtn = document.getElementById('moodRefreshBtn');
export const stageEl = document.getElementById('stage');
export const stageStatus = document.getElementById('stageStatus');
export const stageSkeleton = document.getElementById('stageSkeleton');
export const resetLive2DBtn = document.getElementById('resetLive2DBtn');
export const ttsChk = document.getElementById('ttsChk');
export const ttsEngineSelect = document.getElementById('ttsEngineSelect');
export const ttsVoiceSelect = document.getElementById('ttsVoiceSelect');
export const ttsLangSelect = document.getElementById('ttsLangSelect');
export const ttsLangRow = document.getElementById('ttsLangRow');
export const ttsSpeedInput = document.getElementById('ttsSpeed');
export const siteVolumeInput = document.getElementById('siteVolume');
export const voiceChk = document.getElementById('voiceChk');
export const voiceState = document.getElementById('voiceState');
export const voiceBargeChk = document.getElementById('voiceBargeChk');
export const voiceSilenceInput = document.getElementById('voiceSilence');
export const messagesEmpty = document.getElementById('messagesEmpty');
export const openSettingsBtn = document.getElementById('openSettingsBtn');
export const closeSettingsBtn = document.getElementById('closeSettingsBtn');
export const drawerBackdrop = document.getElementById('drawerBackdrop');
export const mobileReplyStatus = document.getElementById('mobileReplyStatus');
export const mobileMenuBtn = document.getElementById('mobileMenuBtn');
export const mobileConversationTitle = document.getElementById('mobileConversationTitle');
export const conversationSidebar = document.getElementById('conversationSidebar');
export const sidebarBackdrop = document.getElementById('sidebarBackdrop');
export const sidebarBackground = [
  document.querySelector('.app-header'),
  document.querySelector('.chat-panel'),
  stageEl,
].filter(Boolean);
export const sendButtonIdleMarkup = sendBtn.innerHTML;
export const sendButtonStopMarkup = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
export const fleeOverlay = document.getElementById('fleeOverlay');
export const fleeReasonEl = document.getElementById('fleeReason');
export const fleeEtaEl = document.getElementById('fleeEta');
export const narrowSidebarQuery = window.matchMedia('(max-width: 900px)');
