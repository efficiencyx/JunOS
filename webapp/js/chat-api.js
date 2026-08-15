
window.ChatAPI = (function () {
  async function listModels() {
    const r = await fetch('api/models.php');
    if (!r.ok) throw new Error(`models http ${r.status}`);
    return r.json();
  }

  function chat({ messages, model, reasoning, think, outfit_context, conversation_id, idle, ephemeral, client_time, audio }, { onToken, onThinking, onDone, onError, onDebug, onStats, onToolStatus, onSilence, onFled }) {
    const ctrl = new AbortController();

    (async () => {
      try {
        const res = await fetch('api/chat.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, model, reasoning, think, outfit_context, conversation_id, idle, ephemeral, client_time, audio }),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const error = new Error(`http ${res.status}`);
          error.status = res.status;
          onError && onError(error);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const event = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of event.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') {
                onDone && onDone();
                return;
              }
              try {
                const obj = JSON.parse(payload);
                if (obj.error) {
                  const err = new Error(obj.error);
                  err.data = obj;
                  onError && onError(err);
                  continue;
                }
                if (obj.silence) { onSilence && onSilence(obj.silence); continue; }
                if (obj.fled) { onFled && onFled(obj.fled); continue; }
                if (obj.debug) { onDebug && onDebug(obj.debug); continue; }
                if (obj.stats) { onStats && onStats(obj.stats); continue; }
                if (obj.tool_status) { onToolStatus && onToolStatus(obj.tool_status); continue; }
                if (typeof obj.thinking === 'string') { onThinking && onThinking(obj.thinking); continue; }
                if (typeof obj.token === 'string') onToken && onToken(obj.token);
              } catch (e) {}
            }
          }
        }
        onDone && onDone();
      } catch (e) {
        if (e.name !== 'AbortError') onError && onError(e);
      }
    })();

    return () => ctrl.abort();
  }

  return { listModels, chat };
})();
