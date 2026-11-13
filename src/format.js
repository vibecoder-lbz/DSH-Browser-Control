import { parseDocument } from 'yaml';

const looksJson = text => /^[\s\uFEFF]*[{[]/u.test(text);
const looksXml = text => /^\s*<\?xml|^\s*<[A-Za-z][\w:.-]*(?:\s|>)/u.test(text);
const looksSql = text => /^\s*(?:select|insert|update|delete|create|alter|drop|with|begin|commit)\b/iu.test(text);
const looksJs = text => /\b(?:function|const|let|var|=>|import|export|class)\b/u.test(text) && !looksJson(text);

export function detectIndent(text) {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(\t+| +)\S/u.exec(line);
    if (match) return match[1].includes('\t') ? '\t' : match[1].length >= 4 && match[1].length % 4 === 0 ? 4 : 2;
  }
  return 2;
}

/**
 * Recognize the document rather than trusting the editor's language label alone.
 * Numeric/boolean-looking plain text is not guessed as a format.
 */
export function detectFormat(text, language = '') {
  const lang = String(language || '').toLowerCase();
  const label = lang.includes('yaml') || lang === 'yml' ? 'yaml'
    : lang.includes('json') ? 'json'
      : lang.includes('xml') || lang.includes('html') ? 'xml'
        : /properties|ini/u.test(lang) ? 'properties'
          : lang.includes('sql') ? 'sql'
            : /javascript|typescript|jsx|tsx/u.test(lang) ? 'javascript' : '';
  const sniff = () => {
    if (looksJson(text)) { try { JSON.parse(text); return 'json'; } catch { /* could be YAML flow */ } }
    try {
      const doc = parseDocument(text, { strict: true });
      if (!doc.errors.length && (text.includes(':') || text.trimStart().startsWith('- '))) return 'yaml';
    } catch { /* not YAML */ }
    if (looksXml(text)) return 'xml';
    if (looksSql(text)) return 'sql';
    if (looksJs(text)) return 'javascript';
    if (text.split(/\r?\n/u).some(line => /^\s*\[[^\]]+\]\s*$/u.test(line)) && text.split(/\r?\n/u).some(line => /^\s*[^#;!\s][^=:\s]*\s*[=:]/u.test(line))) return 'properties';
    return 'text';
  };
  const sniffed = sniff();
  let format = label || sniffed;
  // An explicit language label can be wrong (for example a plain-text Ace mode).
  // Content wins when the label is generic or conflicts with a strongly valid structure.
  if (!label || label === 'yaml' && sniffed === 'json') format = sniffed;
  const capabilities = format === 'yaml' ? ['yaml_set', 'yaml_delete', 'replace']
    : format === 'json' ? ['json_set', 'json_delete', 'replace']
      : format === 'properties' ? ['properties_set', 'properties_delete', 'replace']
        : format === 'xml' ? ['replace']
          : ['replace'];
  return {
    format,
    language: lang || 'unknown',
    confidence: label && sniffed === label ? 'high' : label ? 'medium' : sniffed === 'text' ? 'low' : 'medium',
    capabilities,
  };
}

function assertPath(path) {
  if (!Array.isArray(path) || path.length === 0) throw new Error('Provide a non-empty path array; whole-document replacement is not allowed.');
  for (const part of path) if (typeof part !== 'string' && !(Number.isSafeInteger(part) && part >= 0)) throw new Error('Path entries must be strings or non-negative integer indexes.');
  return path;
}
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function planJsonEdit(text, args) {
  const original = clone(JSON.parse(text));
  const path = assertPath(args.path);
  const expected = clone(original);
  let parent = expected;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index];
    if (Array.isArray(parent)) {
      if (!Number.isSafeInteger(key) || key < 0 || key >= parent.length) throw new Error('Array path index is missing. createMissing applies only to object keys.');
      parent = parent[key];
    } else if (isPlainObject(parent)) {
      if (!Object.hasOwn(parent, key)) {
        if (args.createMissing !== true) throw new Error('Parent path does not exist. Set createMissing=true explicitly to create missing object containers.');
        const nextKey = path[index + 1];
        parent[key] = typeof nextKey === 'number' ? [] : {};
      }
      parent = parent[key];
    } else throw new Error('The path crosses a JSON primitive.');
  }
  const key = path.at(-1);
  if (args.action === 'json_delete') {
    if (Array.isArray(parent)) {
      if (!Number.isSafeInteger(key) || key < 0 || key >= parent.length) return { text, changed: false, summary: 'Path is already absent.', path };
      parent.splice(key, 1);
    } else if (isPlainObject(parent)) {
      if (!Object.hasOwn(parent, key)) return { text, changed: false, summary: 'Path is already absent.', path };
      delete parent[key];
    } else throw new Error('The path crosses a JSON primitive.');
  } else {
    if (args.action !== 'json_set') throw new Error('Unsupported JSON operation.');
    if (!Object.hasOwn(args, 'value') || args.value === undefined) throw new Error('json_set requires value (null is allowed; undefined is not JSON).');
    let encoded;
    try { encoded = JSON.stringify(args.value); } catch { throw new Error('json_set value must be JSON-serializable.'); }
    if (encoded === undefined) throw new Error('json_set value must be JSON-serializable.');
    if (Array.isArray(parent)) {
      if (!Number.isSafeInteger(key) || key < 0 || key > parent.length) throw new Error('Array insertion requires a non-sparse index within the array.');
      parent[key] = clone(args.value);
    } else if (isPlainObject(parent)) parent[key] = clone(args.value);
    else throw new Error('The path crosses a JSON primitive.');
  }
  const indent = typeof args.indent === 'number' ? args.indent : typeof args.indent === 'string' ? args.indent : detectIndent(text);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let next = JSON.stringify(expected, null, indent);
  if (newline === '\r\n') next = next.replace(/\n/gu, '\r\n');
  if (!text.endsWith('\n')) next = next.replace(/\r?\n$/u, '');
  else if (!next.endsWith(newline)) next += newline;
  const verified = JSON.parse(next);
  if (JSON.stringify(verified) !== JSON.stringify(expected)) throw new Error('JSON edit verification failed.');
  return { text: next, changed: next !== text, summary: args.action === 'json_set' ? 'Set the requested JSON value.' : 'Deleted the requested JSON value.', path, indent };
}

function propertyEntry(line) {
  const match = /^(\s*)([^#!=:\s][^=:]*?)(\s*[=:]\s*)(.*?)(\s*(?:#|!).*)?$/u.exec(line);
  if (!match) return null;
  return { indent: match[1], key: match[2].trim(), separator: match[3], value: match[4], comment: match[5] || '' };
}

export function planPropertiesEdit(text, args) {
  const path = assertPath(args.path);
  if (path.length > 2) throw new Error('Properties paths are [key] or [section,key].');
  const section = path.length === 2 ? String(path[0]) : '';
  const key = String(path.at(-1));
  if (!key || /[=:\r\n]/u.test(key)) throw new Error('Properties key is invalid.');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/u);
  let sectionStart = 0, sectionEnd = lines.length;
  if (section) {
    sectionStart = -1;
    for (let index = 0; index < lines.length; index++) {
      const match = /^\s*\[([^\]]+)\]\s*$/u.exec(lines[index]);
      if (match && match[1].trim() === section) { sectionStart = index; break; }
    }
    if (sectionStart < 0) {
      if (args.createMissing !== true) throw new Error(`Properties section [${section}] does not exist. Set createMissing=true explicitly.`);
      let next = text;
      if (next.length && !next.endsWith('\n')) next += newline;
      next += `[${section}]${newline}${key}=${args.value ?? ''}${newline}`;
      return { text: next, changed: true, summary: `Created section [${section}] and key.`, path };
    }
    sectionEnd = lines.length;
    for (let index = sectionStart + 1; index < lines.length; index++) if (/^\s*\[[^\]]+\]\s*$/u.test(lines[index])) { sectionEnd = index; break; }
  }
  let found = -1;
  for (let index = sectionStart; index < sectionEnd; index++) {
    const entry = propertyEntry(lines[index]);
    if (entry?.key === key) { found = index; break; }
  }
  if (args.action === 'properties_delete') {
    if (found < 0) return { text, changed: false, summary: 'Property is already absent.', path };
    lines.splice(found, 1);
    return { text: lines.join(newline), changed: true, summary: 'Deleted the requested property.', path };
  }
  if (args.action !== 'properties_set') throw new Error('Unsupported properties operation.');
  if (typeof args.value !== 'string') throw new Error('properties_set requires a string value.');
  if (found >= 0) {
    const entry = propertyEntry(lines[found]);
    lines[found] = `${entry.indent}${key}${entry.separator}${args.value}${entry.comment}`;
  } else {
    let insertAt = section ? sectionStart + 1 : lines.length;
    if (section) {
      // Keep the new key with the section's existing entries, before trailing blank lines.
      insertAt = sectionEnd;
      while (insertAt > sectionStart + 1 && !lines[insertAt - 1].trim()) insertAt--;
    }
    lines.splice(insertAt, 0, `${key}=${args.value}`);
  }
  return { text: lines.join(newline), changed: true, summary: 'Set the requested properties value.', path };
}
