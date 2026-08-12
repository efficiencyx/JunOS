
window.ui = (function () {
  var toastTimer = {};
  var toastSeq = 0;

  function toast(msg, kind) {
    kind = kind || 'info';
    var container = document.getElementById('toasts');
    if (!container) return;

    var id = 'toast-' + (++toastSeq);
    var el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.id = id;
    el.textContent = msg;

    var closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () { dismissToast(el); });
    el.appendChild(closeBtn);

    container.appendChild(el);

    el.getBoundingClientRect();
    el.classList.add('toast-visible');

    toastTimer[id] = setTimeout(function () { dismissToast(el); }, 4000);
  }

  function dismissToast(el) {
    if (!el || !el.parentNode) return;
    el.classList.remove('toast-visible');
    el.classList.add('toast-hiding');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 300);
  }

  function setStatus(text, kind) {
    kind = kind || 'idle';
    var pill = document.getElementById('statusPill');
    if (!pill) return;
    pill.textContent = text;
    pill.className = 'status-pill status-' + kind;
  }

  var drawerOpener = null;

  function toggleDrawer(open) {
    var drawer = document.getElementById('settingsDrawer');
    var backdrop = document.getElementById('drawerBackdrop');
    if (!drawer) return;

    if (typeof open === 'undefined') {
      open = !drawer.classList.contains('open');
    }

    if (open) {
      drawerOpener = document.activeElement;
      drawer.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
      document.body.classList.add('drawer-open');
      var tab = drawer.querySelector('.settings-navitem.active');
      if (tab) tab.focus();
    } else {
      drawer.classList.remove('open');
      if (backdrop) backdrop.classList.remove('open');
      document.body.classList.remove('drawer-open');
      if (drawerOpener && drawerOpener.focus && document.contains(drawerOpener)) drawerOpener.focus();
      drawerOpener = null;
    }
  }

  function confirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function close(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey);
        backdrop.classList.remove('open');
        setTimeout(function () {
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        }, 200);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
      }

      var backdrop = document.createElement('div');
      backdrop.className = 'confirm-backdrop';

      var dialog = document.createElement('div');
      dialog.className = 'confirm-dialog';
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');

      if (opts.title) {
        var h = document.createElement('div');
        h.className = 'confirm-title';
        h.textContent = opts.title;
        dialog.appendChild(h);
      }

      var body = document.createElement('div');
      body.className = 'confirm-message';
      body.textContent = opts.message || 'Are you sure?';
      dialog.appendChild(body);

      var actions = document.createElement('div');
      actions.className = 'confirm-actions';

      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'confirm-btn confirm-cancel';
      cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      cancelBtn.addEventListener('click', function () { close(false); });

      var okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'confirm-btn confirm-ok' + (opts.danger ? ' danger' : '');
      okBtn.textContent = opts.confirmLabel || 'Confirm';
      okBtn.addEventListener('click', function () { close(true); });

      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      dialog.appendChild(actions);

      backdrop.appendChild(dialog);
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) close(false);
      });
      document.addEventListener('keydown', onKey);

      document.body.appendChild(backdrop);
      backdrop.getBoundingClientRect(); // force layout first, or the fade has
                                        // nothing to animate from
      backdrop.classList.add('open');
      (opts.danger ? cancelBtn : okBtn).focus();
    });
  }

  return { toast: toast, setStatus: setStatus, toggleDrawer: toggleDrawer, confirm: confirm };
})();
