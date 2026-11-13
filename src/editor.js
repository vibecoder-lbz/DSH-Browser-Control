import { createHash, randomUUID } from 'node:crypto';
import { planYamlEdit } from './yaml-edit.js';
import { detectFormat, planJsonEdit, planPropertiesEdit } from './format.js';
import { publicUrl } from './url.js';
import { parseDocument, visit, isScalar } from 'yaml';

const revision = text => createHash('sha256').update(text).digest('hex');
const sensitiveKey = /api[_-]?key|password|passwd|secret|token|authorization|private[_-]?key/iu;
function redact(text) {
  const spans = [];
  try {
    const doc = parseDocument(text, { strict: false });
    visit(doc, (_key, node) => {
      if (node?.key && isScalar(node.key) && sensitiveKey.test(String(node.key.value)) && node.value?.range) spans.push(node.value.range.slice(0, 2));
    });
  } catch { /* malformed documents still get the line fallback below */ }
  let output = text;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) output = output.slice(0, start) + output.slice(start, end).replace(/[^\r\n]+/gu, '[REDACTED]') + output.slice(end);
  return output.split(/\r?\n/u).map(line => /(?:api[_-]?key|password|passwd|secret|token|authorization|private[_-]?key)\s*["']?\s*[:=]/iu.test(line)
    ? line.replace(/([:=]).*$/u, '$1 [REDACTED]') : line).join('\n');
}

// Public editor APIs only. The hidden textarea of a code editor is not its document.
function discoverEditors() {
  const entries = [];
  const seen = new Set();
  const add = (root, api, kind) => { if (root && !seen.has(root)) { seen.add(root); entries.push({ root, api, kind }); } };
  for (const editor of globalThis.monaco?.editor?.getEditors?.() || []) add(editor.getDomNode(), editor, 'monaco');
  for (const root of document.querySelectorAll('.ace_editor')) {
    if (globalThis.ace?.edit) add(root, globalThis.ace.edit(root), 'ace');
  }
  for (const root of document.querySelectorAll('.CodeMirror')) if (root.CodeMirror) add(root, root.CodeMirror, 'codemirror5');
  for (const root of document.querySelectorAll('textarea:not(.ace_text-input):not(.inputarea):not(.xterm-helper-textarea)')) {
    if (!root.closest('.monaco-editor,.ace_editor,.CodeMirror,.cm-editor,.xterm')) add(root, null, 'textarea');
  }
  return entries.filter(entry => {
    const box = entry.root.getBoundingClientRect();
    if (!entry.root.isConnected || box.width <= 0 || box.height <= 0 || getComputedStyle(entry.root).visibility === 'hidden') return false;
    if (entry.kind === 'textarea') {
      if (box.width < 20 || box.height < 12) return false;
      for (let el = entry.root; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (el.hidden || el.inert || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
    }
    return true;
  });
}

function readEditor(entry) {
  if (!entry.root.isConnected) throw new Error('Editor was detached. List editors again.');
  let text, language, readOnly, model, documentObject;
  if (entry.kind === 'monaco') {
    model = entry.api.getModel();
    if (!model) throw new Error('Monaco editor has no document model.');
    documentObject = model;
    text = model.getValue(); language = model.getLanguageId();
    readOnly = entry.api.getOption(globalThis.monaco.editor.EditorOption.readOnly);
  } else if (entry.kind === 'ace') {
    documentObject = entry.api.getSession();
    text = entry.api.getValue(); language = documentObject.getMode().$id;
    readOnly = entry.api.getReadOnly();
  } else if (entry.kind === 'codemirror5') {
    documentObject = entry.api.getDoc();
    text = entry.api.getValue(); language = entry.api.getOption('mode'); readOnly = Boolean(entry.api.getOption('readOnly'));
  } else {
    text = entry.root.value; language = entry.root.getAttribute('data-language') || 'text';
    readOnly = entry.root.readOnly || entry.root.disabled;
  }
  documentObject ||= entry.root;
  entry.documents ||= new WeakMap();
  if (!entry.documents.has(documentObject)) entry.documents.set(documentObject, `document-${entry.nextDocument = (entry.nextDocument || 0) + 1}`);
  return { text, language: typeof language === 'string' ? language : 'text', readOnly: Boolean(readOnly),
    modelIdentity: entry.documents.get(documentObject), kind: entry.kind };
}

function applyEditor(entry, { before, after, modelIdentity }) {
  if (!entry.root.isConnected) throw new Error('Editor was detached. Preview again.');
  let current;
  const documentObject = entry.kind === 'monaco' ? entry.api.getModel() : entry.kind === 'ace' ? entry.api.getSession() : entry.kind === 'codemirror5' ? entry.api.getDoc() : entry.root;
  const actualIdentity = entry.documents?.get(documentObject);
  if (entry.kind === 'monaco') {
    const model = entry.api.getModel();
    if (!model || entry.api.getOption(globalThis.monaco.editor.EditorOption.readOnly)) throw new Error('Editor is read-only or has no document.');
    current = model.getValue();
  } else if (entry.kind === 'ace') {
    if (entry.api.getReadOnly()) throw new Error('Editor is read-only.');
    current = entry.api.getValue();
  } else if (entry.kind === 'codemirror5') {
    if (entry.api.getOption('readOnly')) throw new Error('Editor is read-only.');
    current = entry.api.getValue();
  } else {
    if (entry.root.readOnly || entry.root.disabled) throw new Error('Editor is read-only.');
    current = entry.root.value;
  }
  if (current !== before || actualIdentity !== modelIdentity) throw new Error('Editor document changed since preview. Read and preview again; no write was made.');
  // Replace only the differing span. Preserve undo history and unrelated editor state.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const insert = after.slice(start, endAfter);
  const position = (text, offset) => { const lines = text.slice(0, offset).split('\n'); return { row: lines.length - 1, column: lines.at(-1).length }; };
  if (entry.kind === 'monaco') {
    const model = entry.api.getModel(); const from = model.getPositionAt(start), to = model.getPositionAt(endBefore);
    entry.api.pushUndoStop();
    if (!entry.api.executeEdits('dsh-structured-edit', [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: insert, forceMoveMarkers: true }])) throw new Error('Monaco rejected the edit.');
    entry.api.pushUndoStop();
  } else if (entry.kind === 'ace') {
    entry.api.session.replace({ start: position(before, start), end: position(before, endBefore) }, insert);
  } else if (entry.kind === 'codemirror5') {
    const from = position(before, start), to = position(before, endBefore);
    entry.api.replaceRange(insert, { line: from.row, ch: from.column }, { line: to.row, ch: to.column }, '+dsh');
  } else {
    entry.root.setRangeText(insert, start, endBefore, 'preserve');
    entry.root.dispatchEvent(new Event('input', { bubbles: true }));
    entry.root.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const actual = entry.kind === 'monaco' ? entry.api.getModel().getValue() : entry.kind === 'textarea' ? entry.root.value : entry.api.getValue();
  if (actual !== after) throw new Error('Editor content changed during write or normalized the edit. Inspect the current document; do not retry automatically.');
  return { verified: true };
}

export class EditorStore {
  constructor() { this.entries = new Map(); this.plans = new Map(); this.nextId = 1; }
  async clear() {
    const entries = [...this.entries.values()]; this.entries.clear(); this.plans.clear();
    await Promise.allSettled(entries.map(entry => entry.handle.dispose()));
  }
  async list(page) {
    await this.clear();
    const editors = [];
    for (const [frameIndex, frame] of page.frames().entries()) {
      let list;
      try {
        list = await frame.evaluateHandle(discoverEditors);
        const properties = await list.getProperties();
        for (const handle of properties.values()) {
          let retained = false;
          try {
            const info = await handle.evaluate(entry => ({ kind: entry.kind, label: entry.root.getAttribute('aria-label') || entry.root.id || entry.kind }));
            const document = await handle.evaluate(readEditor);
            const scenario = detectFormat(document.text, document.language);
            const id = `editor${this.nextId++}`;
            this.entries.set(id, { handle, page, frame, id }); retained = true;
            editors.push({ editorId: id, ...info, language: document.language, readOnly: document.readOnly, format: scenario.format, confidence: scenario.confidence,
              capabilities: scenario.capabilities, frameIndex, frameUrl: publicUrl(frame.url()) });
          } finally { if (!retained) await handle.dispose().catch(() => {}); }
        }
      } finally { await list?.dispose().catch(() => {}); }
    }
    return { editors, notice: 'Supported public APIs: Monaco, Ace, CodeMirror 5 and plain textarea. Other editors require an explicit adapter; do not fill a hidden editor textarea.' };
  }
  async resolve(page, args) {
    if (!args.editorId) {
      const result = await this.list(page);
      if (result.editors.length !== 1) throw new Error(`Found ${result.editors.length} editors. List and choose editorId; no content was modified.`);
      return this.entries.get(result.editors[0].editorId);
    }
    const entry = this.entries.get(args.editorId);
    if (!entry || entry.page !== page) throw new Error('Unknown or stale editorId. List editors in the current copy again.');
    return entry;
  }
  async run(page, args, signal) {
    signal?.throwIfAborted();
    if (args.action === 'list') return this.list(page);
    const savedPlan = args.action === 'apply' ? this.plans.get(args.planId) : undefined;
    const entry = savedPlan && !args.editorId && savedPlan.entry.page === page ? savedPlan.entry : await this.resolve(page, args);
    const current = await entry.handle.evaluate(readEditor);
    if (current.text.length > 1000000) throw new Error('Editor exceeds the 1 MB structured editing limit.');
    const documentRevision = text => revision(JSON.stringify([text, current.modelIdentity, page.url(), entry.frame.url()]));
    const rev = documentRevision(current.text);
    const scenario = detectFormat(current.text, current.language);
    if (args.action === 'read') {
      const start = Math.max(1, args.startLine || 1), count = Math.min(200, Math.max(1, args.lineCount || 60));
      const lines = current.text.split(/\r?\n/u);
      return { editor: { editorId: entry.id, kind: current.kind, language: current.language, readOnly: current.readOnly, revision: rev, totalLines: lines.length,
        format: scenario.format, formatConfidence: scenario.confidence, capabilities: scenario.capabilities,
        content: redact(current.text).split('\n').slice(start - 1, start - 1 + count).map((line, index) => `${start + index}: ${line}`).join('\n') },
        scenario, notice: 'Format detected from editor language and document content. Sensitive-looking assignments are redacted. Revision covers the complete editor document. No publish/save control was activated.' };
    }
    if (args.action === 'preview') {
      if (current.readOnly) throw new Error('Editor is read-only.');
      if (!args.expectedRevision || args.expectedRevision !== rev) throw new Error('Read the editor and provide its current expectedRevision before previewing edits.');
      const options = { ...args, action: args.operation };
      if (typeof args.path === 'string') { try { options.path = JSON.parse(args.path); } catch { throw new Error('path must be a JSON array such as ["env","DIAGNOSIS_MODEL"].'); } }
      const effectiveFormat = args.format || scenario.format;
      if (args.format && scenario.format !== 'text' && args.format !== scenario.format) {
        throw new Error(`This document is detected as ${scenario.format}, not ${args.format}. No edit was planned.`);
      }
      if (['yaml_set', 'yaml_delete'].includes(args.operation) && effectiveFormat !== 'yaml') throw new Error(`YAML structural editing is not valid for this ${effectiveFormat} document. Use its supported operations: ${scenario.capabilities.join(', ')}.`);
      if (['json_set', 'json_delete'].includes(args.operation) && effectiveFormat !== 'json') throw new Error(`JSON structural editing is not valid for this ${effectiveFormat} document. Use its supported operations: ${scenario.capabilities.join(', ')}.`);
      if (['properties_set', 'properties_delete'].includes(args.operation) && effectiveFormat !== 'properties') throw new Error(`Properties editing is not valid for this ${effectiveFormat} document. Use its supported operations: ${scenario.capabilities.join(', ')}.`);
      if (['yaml_set', 'json_set'].includes(args.operation)) {
        if (typeof args.valueJson !== 'string') throw new Error(`${args.operation} requires valueJson, e.g. "\"text\"" or "{\"enabled\":true}".`);
        try { options.value = JSON.parse(args.valueJson); } catch { throw new Error('valueJson is not valid JSON. Quote string values with JSON double quotes.'); }
      }
      if (args.operation === 'properties_set' && typeof args.value !== 'string') throw new Error('properties_set requires a string value.');
      let planned;
      if (args.operation === 'replace') {
        if (!args.oldText || typeof args.newText !== 'string') throw new Error('Exact replace requires non-empty oldText and string newText.');
        if (effectiveFormat === 'yaml') planned = planYamlEdit(current.text, { action: 'replace', oldText: args.oldText, newText: args.newText });
        else {
          const start = current.text.indexOf(args.oldText);
          if (start < 0 || current.text.indexOf(args.oldText, start + 1) >= 0) throw new Error('oldText must match exactly once. Read a unique excerpt first.');
          const replacement = current.text.includes('\r\n') ? args.newText.replace(/\r?\n/gu, '\r\n') : args.newText.replace(/\r\n/gu, '\n');
          const after = current.text.slice(0, start) + replacement + current.text.slice(start + args.oldText.length);
          if (effectiveFormat === 'json') {
            try { JSON.parse(after); } catch { throw new Error('Resulting JSON is invalid; no editor write was made.'); }
          }
          planned = { text: after, changed: after !== current.text, indent: 0, summary: `Replaced one exact excerpt; resulting ${effectiveFormat === 'text' ? 'text' : effectiveFormat} is valid.` };
        }
      } else if (['yaml_set', 'yaml_delete'].includes(args.operation)) planned = planYamlEdit(current.text, options);
      else if (['json_set', 'json_delete'].includes(args.operation)) planned = planJsonEdit(current.text, options);
      else if (['properties_set', 'properties_delete'].includes(args.operation)) planned = planPropertiesEdit(current.text, options);
      else throw new Error('Unsupported preview operation. Use the capabilities reported by read/list.');
      const planId = randomUUID();
      this.plans.clear();
      this.plans.set(planId, { entry, before: current.text, after: planned.text, modelIdentity: current.modelIdentity, pageUrl: page.url(), frameUrl: entry.frame.url(), created: Date.now() });
      const beforeLines = current.text.split(/\r?\n/u), afterLines = planned.text.split(/\r?\n/u);
      const redactedBefore = redact(current.text).split('\n'), redactedAfter = redact(planned.text).split('\n');
      let first = 0; while (first < beforeLines.length && first < afterLines.length && beforeLines[first] === afterLines[first]) first++;
      return { preview: { planId, editorId: entry.id, baseRevision: rev, resultRevision: documentRevision(planned.text), changed: planned.changed, indent: planned.indent, summary: planned.summary,
        format: scenario.format,
        before: redactedBefore.slice(Math.max(0, first - 2), first + 12).join('\n'),
        after: redactedAfter.slice(Math.max(0, first - 2), first + 18).join('\n') }, scenario, notice: 'Preview only: editor and backend are unchanged. Apply this planId to write the editor draft. Publishing is a separate authorized action.' };
    }
    if (args.action === 'apply') {
      const plan = this.plans.get(args.planId);
      if (!plan || plan.entry !== entry || Date.now() - plan.created > 600000) throw new Error('Preview plan expired or belongs to another editor. Read and preview again.');
      if (page.url() !== plan.pageUrl || entry.frame.url() !== plan.frameUrl || current.text !== plan.before || current.modelIdentity !== plan.modelIdentity) throw new Error('Editor changed since preview; no write was made. Read and preview again.');
      signal?.throwIfAborted(); this.plans.delete(args.planId);
      if (plan.before !== plan.after) await entry.handle.evaluate(applyEditor, { before: plan.before, after: plan.after, modelIdentity: plan.modelIdentity });
      return { edit: { editorId: entry.id, changed: plan.before !== plan.after, verified: true, revision: revision(plan.after), published: false }, notice: 'Editor draft updated and read back successfully. The tool did not click publish/save; page-specific auto-save behavior may still exist.' };
    }
    throw new Error('Editor action must be list, read, preview or apply.');
  }
}
