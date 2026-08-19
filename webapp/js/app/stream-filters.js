import { logAction } from './logging.js?v=8';
import { noteEmotionTint } from './mood.js?v=8';

const MARK_RE = /\[\s*(?:A(?:CTIONS?)?|TOOL)\s*:/i;
const PARTIAL_RE = /\[\s*(?:A(?:C(?:T(?:I(?:O(?:N(?:S)?)?)?)?)?)?|T(?:O(?:O(?:L)?)?)?)?\s*$/i;
const TOOL_RE = /^\[\s*TOOL\s*:/i;

function findMark(s, from = 0) {
  const m = s.slice(from).match(MARK_RE);
  return m ? from + m.index : -1;
}

// the tool markers carry a JSON argument, and a ']' can absolutely sit inside
// one of its strings. close on the FIRST ']' and you cut the blob in half and
// the rest streams straight into the bubble. so only a ']' outside any brace
// or string counts.
function findClose(s) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { if (depth > 0) depth--; }
    else if (c === ']' && depth === 0) return i;
  }
  return -1;
}

function pendingMarkerSuffix(s) {
  const m = s.match(PARTIAL_RE);
  return m ? m[0].length : 0;
}

export function makeStreamBuffer(onCleanText) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      while (true) {
        const start = findMark(buf);
        if (start < 0) {
          const hold = pendingMarkerSuffix(buf);
          if (buf.length > hold) {
            onCleanText(buf.slice(0, buf.length - hold));
            buf = buf.slice(buf.length - hold);
          }
          break;
        }
        if (start > 0) {
          onCleanText(buf.slice(0, start));
          buf = buf.slice(start);
        }
        const end = findClose(buf);
        if (end < 0) break;
        const blob = buf.slice(0, end + 1);
        buf = buf.slice(end + 1);
        if (TOOL_RE.test(blob)) {
          // android's tool protocol. never an action, never something Anon
          // should see. swallow it here too, the stored history of the early
          // testers still has these blobs in it and replays through us.
          logAction('info', 'tool marker scartato: ' + blob);
          continue;
        }
        const acts = Actions.parseActions(blob);
        if (acts.length === 0) {
          logAction('warn', 'block non parsabile: ' + blob);
        } else {
          for (const a of acts) {
            Actions.applyAction(a);
            noteEmotionTint(a);
          }
        }
      }
    },
    flush() {
      if (buf.length) {
        const start = findMark(buf);
        if (start >= 0) onCleanText(buf.slice(0, start));
        else onCleanText(buf);
        buf = '';
      }
    },
  };
}

export function makeNameFilter(emit) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      const hold = window.Names ? Names.pendingPartial(buf) : 0;
      if (buf.length > hold) {
        const out = buf.slice(0, buf.length - hold);
        emit(window.Names ? Names.apply(out) : out);
        buf = buf.slice(buf.length - hold);
      }
    },
    flush() {
      if (buf.length) {
        emit(window.Names ? Names.apply(buf) : buf);
        buf = '';
      }
    },
  };
}
