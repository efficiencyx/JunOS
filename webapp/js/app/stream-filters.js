import { logAction } from './logging.js?v=72';
import { noteEmotionTint } from './mood.js?v=72';

const MARK_RE = /\[\s*A(?:CTIONS?)?\s*:/i;
const PARTIAL_RE = /\[\s*(?:A(?:C(?:T(?:I(?:O(?:N(?:S)?)?)?)?)?)?\s*)?$/i;

function findMark(s, from = 0) {
  const m = s.slice(from).match(MARK_RE);
  return m ? from + m.index : -1;
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
        const end = buf.indexOf(']');
        if (end < 0) break; // tag isn't finished yet, wait for the next chunk
        const blob = buf.slice(0, end + 1);
        buf = buf.slice(end + 1);
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
