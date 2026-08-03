// Telemetry consent. Deliberately not mirrored through Prefs/localStorage: the
// consent record is the evidence that consent was given (GDPR art. 7(1)), so the
// server owns it and the client only ever reflects what the server reports.

window.Consent = (function () {
  let state = { available: false, asked: false, granted: false, erasure_requested_at: null };

  async function api(body) {
    const opts = body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {};
    const r = await fetch('api/consent.php', Object.assign({ credentials: 'same-origin' }, opts));
    if (!r.ok) throw new Error('consent_failed');
    return r.json();
  }

  function renderSettings() {
    const chk = document.getElementById('telemetryChk');
    if (chk) {
      chk.checked = state.granted;
      chk.disabled = !state.available;
    }
    const eraseState = document.getElementById('telemetryEraseState');
    if (eraseState) {
      eraseState.textContent = state.erasure_requested_at
        ? 'Requested on ' + new Date(state.erasure_requested_at * 1000).toLocaleDateString() + '.'
        : '';
    }
  }

  async function decide(granted) {
    await api({ granted });
    state.granted = granted;
    state.asked = true;
    renderSettings();
  }

  function showGate() {
    return new Promise(resolve => {
      const gate = document.getElementById('dataConsentGate');
      if (!gate) { resolve(); return; }
      gate.hidden = false;
      const close = async granted => {
        gate.hidden = true;
        try { await decide(granted); } catch (e) { }
        resolve();
      };
      document.getElementById('dataConsentAccept').onclick = () => close(true);
      document.getElementById('dataConsentDecline').onclick = () => close(false);
    });
  }

  function wireSettings() {
    const chk = document.getElementById('telemetryChk');
    if (chk) {
      chk.addEventListener('change', async () => {
        const want = chk.checked;
        try {
          await decide(want);
        } catch (e) {
          chk.checked = !want;
        }
      });
    }

    const eraseBtn = document.getElementById('telemetryEraseBtn');
    if (eraseBtn) {
      eraseBtn.addEventListener('click', async () => {
        const ok = await ui.confirm({
          title: 'Submit deletion request',
          message: 'Submit a request to erase everything shared from this account? Sharing will also be turned off. Submission is not confirmation that deletion has finished.',
          confirmLabel: 'Submit request',
          cancelLabel: 'Cancel',
          danger: true,
        });
        if (!ok) return;
        eraseBtn.disabled = true;
        try {
          await api({ erase: true });
          state.granted = false;
          state.erasure_requested_at = Math.floor(Date.now() / 1000);
          renderSettings();
          ui.toast('Deletion request submitted; this is not confirmation of completion.', 'ok');
        } catch (e) {
          ui.toast('Could not reach the server. Try again later.', 'error');
        } finally {
          eraseBtn.disabled = false;
        }
      });
    }
  }

  async function init() {
    try {
      state = await api(null);
    } catch (e) {
      return;
    }
    wireSettings();
    renderSettings();
    if (state.available && !state.asked) await showGate();
  }

  return { init, get granted() { return state.granted; } };
})();
