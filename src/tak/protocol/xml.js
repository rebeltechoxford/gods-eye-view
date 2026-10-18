// Strict, bounded XML reader/writer for Cursor on Target interchange.
//
// CoT is a small, regular XML dialect. Rather than depend on DOMParser (absent
// in Node, permissive in browsers) this module reads exactly the subset CoT
// needs and refuses everything else:
// - no DTD, no ENTITY declarations, no external or custom entities;
// - only the five predefined entities and numeric character references;
// - bounded depth, node count, attribute count and attribute/text length.
// The same module runs in the browser panel and in the Node gateway, so both
// sides accept and refuse identical documents.

export const XML_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 20_000,
  maxAttributes: 64,
  maxAttributeLength: 4096,
  maxTextLength: 16_384,
  maxNamespaces: 64,
});

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
const PREDEFINED = Object.freeze({
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
});

export class CotXmlError extends Error {
  constructor(message, offset = -1) {
    super(offset >= 0 ? `${message} (at ${offset})` : message);
    this.name = 'CotXmlError';
    this.offset = offset;
  }
}

function isXmlChar(code) {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function decodeEntities(raw, offset) {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&([^;&\s]{1,10});|&/g, (match, body) => {
    if (body === undefined)
      throw new CotXmlError('Bare "&" in XML text', offset);
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits))
        throw new CotXmlError(`Invalid character reference &${body};`, offset);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!isXmlChar(code))
        throw new CotXmlError(
          `Character reference outside XML range &${body};`,
          offset,
        );
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(PREDEFINED, body))
      throw new CotXmlError(`Undeclared entity &${body};`, offset);
    return PREDEFINED[body];
  });
}

/**
 * @typedef {object} XmlElement
 * @property {string} name Qualified name as written.
 * @property {string} localName Name without any namespace prefix.
 * @property {Record<string,string>} attrs Null-prototype attribute map.
 * @property {XmlElement[]} children Child elements in document order.
 * @property {string} text Concatenated direct text content (incl. CDATA).
 */

function localNameOf(name) {
  const colon = name.lastIndexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/**
 * Parse an XML fragment: zero or more top-level elements, optionally preceded
 * by an XML declaration, separated only by whitespace/comments.
 * @param {string} source
 * @param {Partial<typeof XML_LIMITS>} [limits]
 * @returns {XmlElement[]}
 */
export function parseXmlFragment(source, limits = {}) {
  if (typeof source !== 'string') throw new CotXmlError('XML must be a string');
  for (const char of source) {
    if (!isXmlChar(char.codePointAt(0)))
      throw new CotXmlError('Invalid XML character');
  }
  const cap = { ...XML_LIMITS, ...limits };
  const roots = [];
  const stack = [];
  let nodes = 0;
  let i = 0;
  const n = source.length;
  // Tolerate a UTF-8 byte-order mark decoded into the string.
  if (source.charCodeAt(0) === 0xfeff) i = 1;

  const appendText = (raw, at) => {
    if (!raw) return;
    const parent = stack[stack.length - 1];
    if (!parent) {
      if (raw.trim()) throw new CotXmlError('Text outside of an element', at);
      return;
    }
    const decoded = decodeEntities(raw, at);
    if (parent.text.length + decoded.length > cap.maxTextLength)
      throw new CotXmlError('XML text exceeds the length limit', at);
    parent.text += decoded;
    parent.content.push(decoded);
  };

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      appendText(source.slice(i), i);
      break;
    }
    if (lt > i) appendText(source.slice(i, lt), i);
    i = lt;

    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) throw new CotXmlError('Unterminated comment', i);
      if (source.slice(i + 4, end).includes('--'))
        throw new CotXmlError('Invalid XML comment', i);
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end < 0) throw new CotXmlError('Unterminated CDATA section', i);
      const parent = stack[stack.length - 1];
      if (!parent) throw new CotXmlError('CDATA outside of an element', i);
      const text = source.slice(i + 9, end);
      if (parent.text.length + text.length > cap.maxTextLength)
        throw new CotXmlError('XML text exceeds the length limit', i);
      parent.text += text;
      parent.content.push(text);
      i = end + 3;
      continue;
    }
    if (source.startsWith('<!', i)) {
      // DOCTYPE, ENTITY, ELEMENT, ATTLIST... none are acceptable in CoT.
      throw new CotXmlError('DTD and entity declarations are not allowed', i);
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end < 0)
        throw new CotXmlError('Unterminated processing instruction', i);
      // The XML declaration (and any other PI) carries nothing CoT needs.
      i = end + 2;
      continue;
    }
    if (source[i + 1] === '/') {
      const end = source.indexOf('>', i + 2);
      if (end < 0) throw new CotXmlError('Unterminated end tag', i);
      const name = source.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name)
        throw new CotXmlError(`Mismatched end tag </${name}>`, i);
      i = end + 1;
      continue;
    }

    // Start tag: read name, then attributes, honouring quoted '>' characters.
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(source[j])) j++;
    const name = source.slice(i + 1, j);
    if (!NAME.test(name)) throw new CotXmlError(`Invalid element name`, i);
    const attrs = Object.create(null);
    let attrCount = 0;
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(source[j])) j++;
      if (j >= n) throw new CotXmlError('Unterminated start tag', i);
      if (source[j] === '>') {
        j++;
        break;
      }
      if (source[j] === '/' && source[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      let k = j;
      while (k < n && !/[\s=/>]/.test(source[k])) k++;
      const attrName = source.slice(j, k);
      if (!NAME.test(attrName))
        throw new CotXmlError('Invalid attribute name', j);
      while (k < n && /\s/.test(source[k])) k++;
      if (source[k] !== '=')
        throw new CotXmlError(`Attribute ${attrName} has no value`, k);
      k++;
      while (k < n && /\s/.test(source[k])) k++;
      const quote = source[k];
      if (quote !== '"' && quote !== "'")
        throw new CotXmlError(`Attribute ${attrName} is not quoted`, k);
      const close = source.indexOf(quote, k + 1);
      if (close < 0) throw new CotXmlError('Unterminated attribute value', k);
      const raw = source.slice(k + 1, close);
      if (raw.includes('<'))
        throw new CotXmlError('"<" is not allowed in attribute values', k);
      if (raw.length > cap.maxAttributeLength)
        throw new CotXmlError('Attribute value exceeds the length limit', k);
      if (Object.hasOwn(attrs, attrName))
        throw new CotXmlError(`Duplicate attribute ${attrName}`, j);
      if (++attrCount > cap.maxAttributes)
        throw new CotXmlError('Too many attributes on one element', j);
      // Attribute-value normalisation: literal whitespace becomes a space;
      // escaped whitespace (&#10;) survives, so normalise before decoding.
      attrs[attrName] = decodeEntities(raw.replace(/[\t\n\r]/g, ' '), k);
      j = close + 1;
      if (j < n && !/[\s/>]/.test(source[j]))
        throw new CotXmlError('Attributes must be separated by whitespace', j);
    }
    if (++nodes > cap.maxNodes)
      throw new CotXmlError('XML document has too many elements', i);
    /** @type {XmlElement} */
    const element = {
      name,
      localName: localNameOf(name),
      attrs,
      children: [],
      content: [],
      text: '',
    };
    const parent = stack[stack.length - 1];
    const bindings = Object.entries(attrs).filter(
      ([key]) => key === 'xmlns' || key.startsWith('xmlns:'),
    );
    element.namespaces = bindings.length
      ? Object.create(parent?.namespaces || null)
      : parent?.namespaces || Object.create(null);
    element.namespaceCount = parent?.namespaceCount || 0;
    for (const [key, value] of bindings) {
      if (!(key in element.namespaces)) element.namespaceCount++;
      if (element.namespaceCount > cap.maxNamespaces)
        throw new CotXmlError('Too many namespace bindings', i);
      element.namespaces[key] = value;
    }
    for (const qualified of [name, ...Object.keys(attrs)]) {
      if (qualified.includes(':') && !qualified.startsWith('xmlns:')) {
        const prefix = qualified.split(':')[0];
        if (prefix !== 'xml' && !element.namespaces[`xmlns:${prefix}`])
          throw new CotXmlError('Undeclared namespace prefix', i);
      }
    }
    if (parent) {
      parent.children.push(element);
      parent.content.push(element);
    } else roots.push(element);
    if (!selfClosing) {
      if (stack.length + 1 > cap.maxDepth)
        throw new CotXmlError('XML nesting exceeds the depth limit', i);
      stack.push(element);
    }
    i = j;
  }
  if (stack.length)
    throw new CotXmlError(`Unclosed element <${stack[stack.length - 1].name}>`);
  return roots;
}

/** Parse a document that must contain exactly one root element. */
export function parseXmlDocument(source, limits) {
  const roots = parseXmlFragment(source, limits);
  if (roots.length !== 1)
    throw new CotXmlError(
      roots.length ? 'XML has more than one root element' : 'XML is empty',
    );
  return roots[0];
}

/** First direct child with a given local name, or null. */
export function childElement(parent, localName) {
  if (!parent) return null;
  for (const child of parent.children)
    if (child.localName === localName) return child;
  return null;
}

/** All direct children with a given local name. */
export function childElements(parent, localName) {
  return parent ? parent.children.filter((c) => c.localName === localName) : [];
}

/** All descendants (depth-first, document order) with a given local name. */
export function descendantElements(roots, localName) {
  const found = [];
  const visit = (element) => {
    if (element.localName === localName) {
      found.push(element);
      return; // CoT events never nest; do not descend into a match.
    }
    for (const child of element.children) visit(child);
  };
  for (const root of Array.isArray(roots) ? roots : [roots]) visit(root);
  return found;
}

function stripInvalidXmlChars(value) {
  let out = '';
  for (const char of value) {
    if (isXmlChar(char.codePointAt(0))) out += char;
  }
  return out;
}

export function escapeXmlText(value) {
  return stripInvalidXmlChars(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(value) {
  return escapeXmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

/**
 * Serialise an element tree. Names are re-validated so a caller-constructed
 * tree can never smuggle markup through an element or attribute name.
 * @param {XmlElement|{name:string,attrs?:object,children?:object[],text?:string}} element
 * @returns {string}
 */
export function serializeXmlElement(element) {
  const name = String(element?.name ?? '');
  if (!NAME.test(name)) throw new CotXmlError(`Invalid element name ${name}`);
  let out = '<' + name;
  const attrs = element.attrs || {};
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === undefined || value === null) continue;
    if (!NAME.test(key)) throw new CotXmlError(`Invalid attribute name ${key}`);
    out += ` ${key}="${escapeXmlAttribute(value)}"`;
  }
  const children = element.children || [];
  const text = element.text ? escapeXmlText(element.text) : '';
  if (!children.length && !text) return out + '/>';
  out += '>';
  if (element.content) {
    for (const item of element.content)
      out +=
        typeof item === 'string'
          ? escapeXmlText(item)
          : serializeXmlElement(item);
  } else {
    out += text;
    for (const child of children) out += serializeXmlElement(child);
  }
  return out + `</${name}>`;
}
