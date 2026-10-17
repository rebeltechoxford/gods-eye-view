// Frame a CoT XML byte stream (TAK Server "streaming" TCP/TLS, file tails)
// into individual <event> documents. Portable: callers decode bytes to text
// (e.g. socket.setEncoding('utf8') or a streaming TextDecoder) first.

import { MAX_COT_EVENT_BYTES, byteLength } from './cot.js';

const START = '<event';

function findStart(buffer) {
  let at = 0;
  outer: while ((at = buffer.indexOf('<', at)) >= 0) {
    const rest = buffer.slice(at);
    for (const [open, close] of [
      ['<!--', '-->'],
      ['<?', '?>'],
      ['<![CDATA[', ']]>'],
    ]) {
      if (open.startsWith(rest)) return { keep: at };
      if (!rest.startsWith(open)) continue;
      const end = buffer.indexOf(close, at + open.length);
      if (end < 0) return { keep: at };
      at = end + close.length;
      continue outer;
    }
    if (rest.startsWith('<!')) return { invalid: true };
    if (START.startsWith(rest)) return { keep: at };
    if (/^<event[\s/>]/.test(rest)) return { start: at };
    at++;
  }
  return { keep: buffer.length };
}

// Event-like text inside comments or CDATA is payload, not framing. Scan only
// actual markup. A fresh event before the old end resynchronizes truncation.
function findBoundary(buffer, from) {
  let at = from;
  while ((at = buffer.indexOf('<', at)) >= 0) {
    const rest = buffer.slice(at);
    const special = [
      ['<!--', '-->'],
      ['<![CDATA[', ']]>'],
      ['<?', '?>'],
    ].find(([start]) => rest.startsWith(start));
    if (special) {
      const end = buffer.indexOf(special[1], at + special[0].length);
      if (end < 0) return null;
      at = end + special[1].length;
      continue;
    }
    const end = /^<\/event\s*>/.exec(rest);
    if (end) return { stop: at + end[0].length };
    if (/^<event[\s/>]/.test(rest)) return { inner: at };
    at++;
  }
  return null;
}

/** Byte header of TAK Protocol v1 (protobuf) packets; never valid XML. */
export const TAK_PROTO_MAGIC = 0xbf;

/** Detect a TAK protocol v1 (protobuf) datagram/stream header. */
export function isTakProtobuf(bytes) {
  return !!bytes && bytes.length > 0 && bytes[0] === TAK_PROTO_MAGIC;
}

/**
 * Locate the end of the start tag beginning at `from` (the '<' of "<event"),
 * honouring quoted attribute values. Returns the index just past '>' and
 * whether the tag was self-closing, or null if the tag is not complete yet.
 */
function scanStartTag(buffer, from) {
  let quote = null;
  for (let i = from + START.length; i < buffer.length; i++) {
    const c = buffer[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return { end: i + 1, selfClosing: buffer[i - 1] === '/' };
    }
  }
  return null;
}

/**
 * @param {object} options
 * @param {(xml:string)=>void} options.onEvent Called once per complete event.
 * @param {(reason:string, dropped:number)=>void} [options.onDiscard]
 * @param {number} [options.maxEventBytes]
 */
export function createCotStreamFramer({
  onEvent,
  onDiscard = () => {},
  maxEventBytes = MAX_COT_EVENT_BYTES,
}) {
  let buffer = '';
  let framed = 0;
  let discarded = 0;
  let poisoned = false;

  function discard(reason, count) {
    discarded += count;
    onDiscard(reason, count);
  }

  function drain() {
    for (;;) {
      const found = findStart(buffer);
      if (found.invalid) {
        poisoned = true;
        buffer = '';
        discard('DTD or invalid declaration', 1);
        return;
      }
      const start = found.start;
      if (start === undefined) {
        // Retain only incomplete markup; completed comments/instructions
        // cannot inject an event into the stream.
        buffer = buffer.slice(found.keep);
        if (byteLength(buffer) > maxEventBytes) {
          discard('oversized preamble', 1);
          buffer = '';
        }
        return;
      }
      // Next char must delimit the name: "<events>" is a wrapper, not an event.
      const delimiter = buffer[start + START.length];
      if (delimiter === undefined) {
        buffer = buffer.slice(start);
        return;
      }
      if (!/[\s/>]/.test(delimiter)) {
        buffer = buffer.slice(start + START.length);
        continue;
      }
      if (start > 0) buffer = buffer.slice(start);
      const tag = scanStartTag(buffer, 0);
      if (!tag) {
        if (byteLength(buffer) > maxEventBytes) {
          discard('oversized event', 1);
          buffer = buffer.slice(START.length);
          continue;
        }
        return;
      }
      if (tag.selfClosing) {
        if (byteLength(buffer.slice(0, tag.end)) > maxEventBytes) {
          discard('oversized event', 1);
          buffer = buffer.slice(tag.end);
          continue;
        }
        framed++;
        const xml = buffer.slice(0, tag.end);
        buffer = buffer.slice(tag.end);
        onEvent(xml);
        continue;
      }
      const boundary = findBoundary(buffer, tag.end);
      if (!boundary) {
        if (byteLength(buffer) > maxEventBytes) {
          discard('oversized event', 1);
          buffer = buffer.slice(START.length);
          continue;
        }
        return;
      }
      const { stop, inner } = boundary;
      // An event must not contain another "<event" start: if it does the
      // first one was truncated; resynchronise on the inner start.
      if (inner > 0) {
        discard('truncated event', 1);
        buffer = buffer.slice(inner);
        continue;
      }
      if (byteLength(buffer.slice(0, stop)) > maxEventBytes) {
        discard('oversized event', 1);
        buffer = buffer.slice(stop);
        continue;
      }
      framed++;
      const xml = buffer.slice(0, stop);
      buffer = buffer.slice(stop);
      onEvent(xml);
    }
  }

  return Object.freeze({
    /** Append decoded text from the stream. */
    push(chunk) {
      if (!chunk) return;
      if (poisoned) return;
      buffer += chunk;
      drain();
    },
    /** Discard any partial event (e.g. on reconnect). */
    reset() {
      buffer = '';
      poisoned = false;
    },
    stats: () => ({ framed, discarded, buffered: buffer.length }),
  });
}
