import { isDeepStrictEqual } from 'node:util';
import { parseDocument, isMap, isSeq, isScalar, Scalar, visit } from 'yaml';

const STANDARD_TAG = /^tag:yaml\.org,2002:(?:map|seq|str|null|bool|int|float|binary|timestamp|set|omap|pairs)$/u;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function parse(text) {
  const doc = parseDocument(text, { keepSourceTokens: true, uniqueKeys: true, prettyErrors: true, strict: true });
  if (doc.errors.length) throw new Error(`Cannot edit invalid YAML: ${doc.errors[0].message}`);
  visit(doc, (_key, node) => {
    if (node?.tag && !STANDARD_TAG.test(node.tag)) throw new Error('Cannot edit YAML with unsupported custom tags.');
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key) && pair.key.value === '<<') throw new Error('Cannot edit YAML with merge keys: merged values are ambiguous.');
      }
    }
  });
  if (doc.warnings.length) throw new Error(`Cannot safely edit this YAML: ${doc.warnings[0].message}`);
  // Also reject unresolved aliases before changing anything; cap alias expansion.
  try { doc.toJS({ mapAsMap: true, maxAliasCount: 100 }); }
  catch (error) { throw new Error(`Cannot safely resolve YAML aliases: ${error.message}`); }
  return doc;
}

function indentOf(text) {
  const widths = [];
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*(?:#|$)/u.test(line)) continue;
    const match = /^( +)(?:[\w"']|-(?: |$))/u.exec(line);
    if (match) widths.push(match[1].length);
  }
  const positive = widths.filter(width => width > 0);
  if (!positive.length) return 2;
  const minimum = Math.min(...positive);
  return minimum >= 4 && positive.every(width => width % 4 === 0) ? 4 : 2;
}

function pathOf(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Provide a non-empty path array; replacing the YAML root is not allowed.');
  for (const part of value) {
    if (typeof part !== 'string' && !(Number.isSafeInteger(part) && part >= 0)) throw new Error('Path entries must be strings or non-negative integer sequence indexes.');
  }
  return [...value];
}

function validateJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('value must be finite, acyclic JSON data.');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error('value must contain only plain JSON objects and arrays.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!own(value, index)) throw new Error('value cannot contain sparse arrays.');
      validateJson(value[index], seen);
    }
  } else for (const key of Object.keys(value)) validateJson(value[key], seen);
  seen.delete(value);
}

function checkContainer(node, key) {
  if (isSeq(node)) {
    if (!Number.isSafeInteger(key) || key < 0) throw new Error('A sequence path entry must be a non-negative integer.');
    return;
  }
  if (isMap(node)) {
    if (typeof key !== 'string') throw new Error('A mapping path entry must be a string key.');
    return;
  }
  throw new Error('The path crosses a scalar or alias; only explicit mapping and sequence children can be edited.');
}

function nodeValue(doc, path) {
  let value = doc.toJS({ mapAsMap: true, maxAliasCount: 100 });
  for (const key of path) {
    if (value instanceof Map) value = value.get(key);
    else if (Array.isArray(value)) value = value[key];
    else return undefined;
  }
  return normalize(value);
}
function normalize(value) {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, normalize(item)]));
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

// Expand aliases into independent semantic branches. structuredClone would retain
// shared object identity, letting an edit accidentally mutate the expected alias too.
function expanded(value, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new Error('Cannot edit YAML with cyclic aliases.');
  ancestors.add(value);
  let result;
  if (value instanceof Map) result = new Map([...value].map(([key, item]) => [expanded(key, ancestors), expanded(item, ancestors)]));
  else if (Array.isArray(value)) result = value.map(item => expanded(item, ancestors));
  else if (value instanceof Set) result = new Set([...value].map(item => expanded(item, ancestors)));
  else if (value instanceof Date) result = new Date(value.getTime());
  else if (ArrayBuffer.isView(value)) result = value.slice();
  else result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expanded(item, ancestors)]));
  ancestors.delete(value);
  return result;
}
function semantic(doc) { return expanded(doc.toJS({ mapAsMap: true, maxAliasCount: 100 })); }
function expectedEdit(root, path, action, value) {
  const container = next => typeof next === 'number' ? [] : new Map();
  if (root === null) root = container(path[0]);
  let parent = root;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index];
    if (parent instanceof Map) {
      if (!parent.has(key)) parent.set(key, container(path[index + 1]));
      parent = parent.get(key);
    } else {
      if (parent[key] === undefined) parent[key] = container(path[index + 1]);
      parent = parent[key];
    }
  }
  const key = path.at(-1);
  if (action === 'yaml_delete') {
    if (parent instanceof Map) parent.delete(key);
    else parent.splice(key, 1);
  } else {
    // Input JSON mappings must compare as YAML mappings, including __proto__.
    const jsonMap = item => Array.isArray(item) ? item.map(jsonMap) : item !== null && typeof item === 'object' ? new Map(Object.entries(item).map(([name, entry]) => [name, jsonMap(entry)])) : item;
    if (parent instanceof Map) parent.set(key, jsonMap(value));
    else parent[key] = jsonMap(value);
  }
  return root;
}

function preserveMetadata(previous, next) {
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return;
  for (const key of ['comment', 'commentBefore', 'spaceBefore', 'anchor']) if (previous[key] !== undefined) next[key] = previous[key];
  if (isScalar(previous) && isScalar(next) && typeof previous.value === 'string' && typeof next.value === 'string' && !next.value.includes('\n')) {
    if ([Scalar.QUOTE_DOUBLE, Scalar.QUOTE_SINGLE].includes(previous.type)) next.type = previous.type;
  }
}
function literalStrings(node) {
  visit(node, (_key, item) => {
    if (isScalar(item) && typeof item.value === 'string' && item.value.includes('\n')) item.type = Scalar.BLOCK_LITERAL;
  });
}
function finish(text, rendered) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let next = rendered.replace(/\r\n/gu, '\n');
  if (!text.endsWith('\n')) next = next.replace(/\n$/u, '');
  return newline === '\r\n' ? next.replace(/\n/gu, '\r\n') : next;
}

/** Plan a local editor change; never writes files or submits an external editor. */
export function planYamlEdit(text, args = {}) {
  if (typeof text !== 'string') throw new Error('Editor text must be a string.');
  const doc = parse(text);
  const indent = indentOf(text);
  const unchanged = (summary, path) => ({ text, changed: false, summary, ...(path ? { path } : {}), indent });
  if (args.action === 'replace') {
    if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') throw new Error('replace requires non-empty oldText and string newText.');
    const start = text.indexOf(args.oldText);
    if (start < 0) throw new Error('Exact oldText was not found. Read the editor again before replacing.');
    if (text.indexOf(args.oldText, start + 1) >= 0) throw new Error('Exact oldText matches more than once; provide a unique excerpt.');
    if (args.oldText === args.newText) return unchanged('Exact replacement is unchanged.');
    const replacement = text.includes('\r\n') ? args.newText.replace(/\r?\n/gu, '\r\n') : args.newText.replace(/\r\n/gu, '\n');
    const next = text.slice(0, start) + replacement + text.slice(start + args.oldText.length);
    parse(next);
    return { text: next, changed: next !== text, summary: next === text ? 'Exact replacement is unchanged.' : 'Replaced one exact excerpt; resulting YAML is valid.', indent };
  }
  if (!['yaml_set', 'yaml_delete'].includes(args.action)) throw new Error('Unsupported edit action. Use yaml_set, yaml_delete, or replace.');
  const path = pathOf(args.path);
  if (args.action === 'yaml_set') {
    if (!own(args, 'value')) throw new Error('yaml_set requires value (null is allowed).');
    validateJson(args.value);
  }
  const before = semantic(doc);
  let parent = doc.contents;
  if (!parent && args.createMissing === true && args.action === 'yaml_set') {
    parent = doc.createNode(typeof path[0] === 'number' ? [] : {});
    doc.contents = parent;
  }
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index];
    checkContainer(parent, key);
    if (!parent.has(key)) {
      if (args.action !== 'yaml_set' || args.createMissing !== true) throw new Error('Parent path does not exist. Set createMissing=true explicitly to create missing containers.');
      if (isSeq(parent) && key > parent.items.length) throw new Error('Cannot create sparse YAML sequences.');
      parent.set(key, doc.createNode(typeof path[index + 1] === 'number' ? [] : {}));
    }
    parent = parent.get(key, true);
  }
  const key = path.at(-1);
  checkContainer(parent, key);
  const exists = parent.has(key);
  if (args.action === 'yaml_delete') {
    if (!exists) return unchanged('Path is already absent.', path);
    parent.delete(key);
  } else {
    if (exists && isDeepStrictEqual(nodeValue(doc, path), args.value)) return unchanged('Value is already unchanged.', path);
    if (isSeq(parent) && key > parent.items.length) throw new Error('Cannot create sparse YAML sequences.');
    const next = doc.createNode(args.value);
    preserveMetadata(parent.get(key, true), next);
    literalStrings(next);
    parent.set(key, next);
  }
  const result = finish(text, doc.toString({ indent, lineWidth: 0 }));
  const verified = parse(result);
  const expected = expectedEdit(before, path, args.action, args.value);
  if (!isDeepStrictEqual(semantic(verified), expected)) throw new Error('YAML edit would change configuration outside the requested path, possibly through an anchor or alias. Edit independent values explicitly instead.');
  if (args.action === 'yaml_set' && !isDeepStrictEqual(nodeValue(verified, path), args.value)) throw new Error('YAML edit verification failed: the resulting value differs from the requested JSON value.');
  // Sequence deletion shifts subsequent indexes, so verify the resulting parent
  // rather than checking absence at the old numeric index.
  if (args.action === 'yaml_delete' && !isDeepStrictEqual(nodeValue(verified, path.slice(0, -1)), nodeValue(doc, path.slice(0, -1)))) throw new Error('YAML deletion verification failed.');
  return { text: result, changed: result !== text, summary: args.action === 'yaml_set' ? 'Set the requested YAML value; resulting YAML is valid.' : 'Deleted the requested YAML value; resulting YAML is valid.', path, indent };
}
