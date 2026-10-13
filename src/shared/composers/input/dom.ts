import { splitReferences, type Reference } from "@/shared/references";

/** How the input shows a reference: as an atomic pill, or undefined to leave its source as text. */
export type ComposerReferences = (
  reference: Reference,
) => { title: string; className: string } | undefined;
/** The caret's editable text run, addressed in offsets of `text`. */
export type ComposerSelection = {
  /** Identifies the run across reads. */
  key: Text;
  /** The run after one character of left context ("" at the start), so triggers can test boundaries. */
  text: string;
  caret: number;
  replace: (from: number, to: number, text: string) => boolean;
};

const REFERENCE = "data-composer-reference";
const CARET = "data-composer-caret";
const nativeCommands = new WeakSet<HTMLElement>();

function referenceEnd(reference: Element): Element {
  const next = reference.nextSibling;
  return next instanceof Element && next.hasAttribute(CARET) && next.matches(":empty")
    ? next
    : reference;
}

/** A ready native surface must be focused synchronously, including on mobile. */
export function focusComposer(root: HTMLElement): void {
  if (!root.isContentEditable) return;
  root.focus();
  if (root.ownerDocument.activeElement !== root) return;
  const range = root.ownerDocument.createRange();
  const last = root.lastChild;
  range.selectNodeContents(
    last instanceof Element &&
      last.hasAttribute(CARET) &&
      last.previousElementSibling?.hasAttribute(REFERENCE)
      ? last
      : root,
  );
  range.collapse(false);
  selectComposerRange(root, range);
}

/** WebKit needs an editable caret stop after a non-editable inline box. No hidden text. */
export function prepareComposer(root: HTMLElement): void {
  for (const caret of root.querySelectorAll(`[${CARET}]:empty`)) {
    const reference = caret.previousSibling;
    if (!(reference instanceof Element) || !reference.hasAttribute(REFERENCE)) caret.remove();
  }
  for (const reference of root.querySelectorAll<HTMLElement>(`[${REFERENCE}]`)) {
    if (reference.contentEditable !== "false") reference.contentEditable = "false";
    if (reference.nextSibling instanceof Element && reference.nextSibling.hasAttribute(CARET))
      continue;
    const caret = root.ownerDocument.createElement("span");
    caret.setAttribute(CARET, "");
    reference.after(caret);
  }
  // A final break only holds an empty last line after a newline. WebKit leaves one after deleting
  // a final reference without a key event, where it would swallow the next deletion.
  const last = root.lastChild;
  if (last?.nodeName === "BR" && last.previousSibling?.nodeName !== "BR") last.remove();
}

export function composerContents(
  document: Document,
  value: string,
  references: ComposerReferences,
  trailingBreak = true,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  function append(text: string) {
    text.split("\n").forEach((line, index) => {
      if (index) fragment.append(document.createElement("br"));
      if (line) fragment.append(document.createTextNode(line));
    });
  }
  // References without a pill stay in the text around them.
  let text = "";
  for (const segment of splitReferences(value)) {
    if (typeof segment === "string") {
      text += segment;
      continue;
    }
    const source = value.slice(segment.from, segment.to);
    const pill = references(segment);
    if (!pill) {
      text += source;
      continue;
    }
    append(text);
    text = "";
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.setAttribute(REFERENCE, source);
    span.textContent = segment.label;
    span.title = pill.title;
    span.className = pill.className;
    span.setAttribute("aria-label", pill.title);
    fragment.append(span);
  }
  append(text);
  // Native editing needs a final, non-content BR to display an empty last line.
  if (trailingBreak && value.endsWith("\n")) fragment.append(document.createElement("br"));
  return fragment;
}

/** Only text and the original source of non-editable references cross the input boundary. */
export function composerValue(root: Node, includeTrailingBreak = false): string {
  return [...root.childNodes]
    .map((node, index) => {
      if (node.nodeType === 3) return node.textContent ?? "";
      if (node instanceof Element && node.hasAttribute(REFERENCE))
        return node.getAttribute(REFERENCE);
      if (node.nodeName === "BR") {
        let next = node.nextSibling;
        while (next?.nodeType === 3 && !next.textContent) next = next.nextSibling;
        return next || includeTrailingBreak ? "\n" : "";
      }
      const line = index > 0 && ["DIV", "P"].includes(node.nodeName) ? "\n" : "";
      return line + composerValue(node, includeTrailingBreak);
    })
    .join("");
}

function prefixValue(root: HTMLElement, node: Node, offset: number): string {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return composerValue(range.cloneContents(), true);
}

/** The selected range, widened to whole references. */
export function selectedComposerRange(root: HTMLElement): Range | undefined {
  const selection = root.ownerDocument.getSelection();
  if (
    selection?.rangeCount &&
    root.contains(selection.anchorNode) &&
    root.contains(selection.focusNode)
  ) {
    return atomicRange(root, selection.getRangeAt(0).cloneRange());
  }
}

function atomicRange(root: HTMLElement, range: Range): Range {
  const startNode = range.startContainer;
  const endNode = range.endContainer;
  const start = (startNode instanceof Element ? startNode : startNode.parentElement)?.closest(
    `[${REFERENCE}]`,
  );
  const previous = range.collapsed ? undefined : range.endContainer.childNodes[range.endOffset - 1];
  const end =
    (endNode instanceof Element ? endNode : endNode.parentElement)?.closest(`[${REFERENCE}]`) ??
    (previous instanceof Element && previous.hasAttribute(REFERENCE) ? previous : null);
  if (start && root.contains(start)) range.setStartBefore(start);
  if (end && root.contains(end)) {
    range.setEndAfter(referenceEnd(end));
  }
  return range;
}

/** The empty caret box belongs to its reference, including in native deletion/undo. */
function composerDeletion(
  root: HTMLElement,
  backwards: boolean,
  intended?: Range,
): Range | undefined {
  const range = intended ? atomicRange(root, intended) : selectedComposerRange(root);
  if (!range) return;
  if (!range.collapsed)
    return range.cloneContents().querySelector(`[${REFERENCE}]`) ? range : undefined;
  const node = range.startContainer;
  const offset = range.startOffset;
  const parent = node instanceof Element ? node : node.parentElement;
  const caret = parent?.closest(`[${CARET}]`);
  let adjacent: Node | null | undefined;
  if (backwards && caret?.matches(":empty")) adjacent = caret.previousSibling;
  else if (node.nodeType === 3) {
    if (offset !== (backwards ? 0 : node.textContent?.length)) return;
    adjacent = backwards ? node.previousSibling : node.nextSibling;
  } else adjacent = node.childNodes[offset - Number(backwards)];
  while (adjacent?.nodeType === 3 && !adjacent.textContent)
    adjacent = backwards ? adjacent.previousSibling : adjacent.nextSibling;
  if (
    backwards &&
    adjacent instanceof Element &&
    adjacent.hasAttribute(CARET) &&
    adjacent.matches(":empty")
  )
    adjacent = adjacent.previousSibling;
  if (!(adjacent instanceof Element) || !adjacent.hasAttribute(REFERENCE)) return;
  range.setStartBefore(adjacent);
  range.setEndAfter(referenceEnd(adjacent));
  return range;
}

/** Empty caret decorations must not survive a native deletion as phantom blank lines. */
function prepareComposerEdit(root: HTMLElement, range: Range): void {
  if (!range.collapsed) {
    for (const caret of root.querySelectorAll(`[${CARET}]:empty`)) {
      if (range.intersectsNode(caret)) caret.remove();
    }
  }
  selectComposerRange(root, range);
}

function selectComposerRange(root: HTMLElement, range: Range): void {
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Only reference-intersecting intents need intervention. Native ranges win over inference. */
export function composerInputDeletion(root: HTMLElement, event: InputEvent): Range | undefined {
  if (nativeCommands.has(root)) return;
  const target = event.getTargetRanges?.()[0];
  let intended: Range | undefined;
  if (target && root.contains(target.startContainer) && root.contains(target.endContainer)) {
    intended = root.ownerDocument.createRange();
    intended.setStart(target.startContainer, target.startOffset);
    intended.setEnd(target.endContainer, target.endOffset);
  }
  const range = composerDeletion(root, event.inputType.endsWith("Backward"), intended);
  return range?.cloneContents().querySelector(`[${CARET}]:empty`) ? range : undefined;
}

/** The command owns browser workarounds and rejects synchronously reentrant commands. */
export function insertComposerText(
  root: HTMLElement,
  range: Range,
  text: string,
  references: ComposerReferences,
): boolean {
  if (
    nativeCommands.has(root) ||
    !root.isContentEditable ||
    !root.contains(range.commonAncestorContainer)
  )
    return false;
  root.focus();
  if (root.ownerDocument.activeElement !== root) return false;
  prepareComposerEdit(root, range);
  const tail = range.cloneRange();
  tail.selectNodeContents(root);
  tail.setStart(range.endContainer, range.endOffset);
  const container = root.ownerDocument.createElement("div");
  container.append(
    composerContents(root.ownerDocument, text, references, !composerValue(tail.cloneContents())),
  );
  // WebKit's undo duplicates spans inserted as non-editable; restore atomicity after the command.
  for (const reference of container.querySelectorAll(`[${REFERENCE}]`))
    reference.removeAttribute("contenteditable");
  nativeCommands.add(root);
  try {
    return root.ownerDocument.execCommand(
      text ? "insertHTML" : "delete",
      false,
      container.innerHTML,
    );
  } catch (error) {
    console.error("Native composer edit failed:", error);
    return false;
  } finally {
    nativeCommands.delete(root);
    prepareComposer(root);
  }
}

export function selectedComposerText(root: HTMLElement, range: Range): string {
  const value = composerValue(root);
  const from = prefixValue(root, range.startContainer, range.startOffset).length;
  const to = prefixValue(root, range.endContainer, range.endOffset).length;
  return value.slice(from, to);
}

/** A completion edits a native text run, never a projected document or a reference's label. */
export function composerSelection(
  root: HTMLElement,
  insert: (range: Range, text: string) => boolean,
): ComposerSelection | undefined {
  const range = selectedComposerRange(root);
  if (!range?.collapsed || root.ownerDocument.activeElement !== root) return;
  let node = range.startContainer;
  let caret = range.startOffset;
  if (node.nodeType !== 3) {
    const before = node.childNodes[caret - 1];
    const after = node.childNodes[caret];
    if (before?.nodeType === 3) {
      node = before;
      caret = before.textContent?.length ?? 0;
    } else if (after?.nodeType === 3) {
      node = after;
      caret = 0;
    } else return;
  }
  if (node.parentElement?.closest(`[${REFERENCE}]`)) return;
  let first = node as Text;
  while (first.previousSibling?.nodeType === 3) {
    first = first.previousSibling as Text;
    caret += first.length;
  }
  const nodes: Text[] = [];
  for (let current: Node | null = first; current?.nodeType === 3; current = current.nextSibling)
    nodes.push(current as Text);
  const prefix = prefixValue(root, first, 0).slice(-1);
  const text = prefix + nodes.map((text) => text.data).join("");
  function point(offset: number): [Text, number] {
    let remaining = offset - prefix.length;
    for (const text of nodes) {
      if (remaining <= text.length) return [text, remaining];
      remaining -= text.length;
    }
    const last = nodes.at(-1)!;
    return [last, last.length];
  }
  return {
    key: first,
    text,
    caret: caret + prefix.length,
    replace(from, to, value) {
      if (from < prefix.length || !nodes.every((node) => root.contains(node))) return false;
      const replacement = root.ownerDocument.createRange();
      replacement.setStart(...point(from));
      replacement.setEnd(...point(to));
      return insert(replacement, value);
    },
  };
}
