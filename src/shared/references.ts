/** Hosts own the meaning of each kind and target; the label is a display snapshot. */
export type Reference = {
  kind: string;
  target: string;
  label: string;
};

/** A reference found in text, addressed by its source range. */
type FoundReference<Found extends Reference> = Found & {
  from: number;
  to: number;
};

const REFERENCE = /\[((?:\\.|[^\]\\\r\n])*)\]\(([a-z][a-z0-9+.-]*):([^\s()]+)\)/iu;

export function encodeReference(reference: Reference): string {
  if (!/^[a-z][a-z0-9+.-]*$/iu.test(reference.kind))
    throw new Error("Reference kinds must be URI-scheme identifiers.");
  if (!reference.target || /\p{Cc}/u.test(reference.target))
    throw new Error("Reference targets must be nonempty and contain no control characters.");
  const label = reference.label
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[\\[\]]/gu, "\\$&");
  // Escape only what a Markdown link destination cannot carry, so targets stay legible to agents.
  const target = reference.target.replace(/[%()\\\s]/gu, (character) =>
    character === "(" ? "%28" : character === ")" ? "%29" : encodeURIComponent(character),
  );
  return `[${label}](${reference.kind}:${target})`;
}

/** An unlabeled reference displays its target, so every decoded reference has a label. */
export function decodeReference(source: string): Reference | undefined {
  const match = REFERENCE.exec(source);
  if (!match || match[0] !== source) return;
  let target: string;
  try {
    target = decodeURIComponent(match[3]!);
  } catch {
    return;
  }
  if (!target || /\p{Cc}/u.test(target)) return;
  return { kind: match[2]!, target, label: match[1]!.replace(/\\(.)/gu, "$1") || target };
}

/**
 * Text as literal runs and the references a host accepts, in source order. Scanning ignores
 * surrounding Markdown; rejected references stay in the literal text around them.
 */
export function splitReferences<Accepted extends Reference = Reference>(
  content: string,
  accept: (reference: Reference) => reference is Accepted = (_all): _all is Accepted => true,
): Array<string | FoundReference<Accepted>> {
  const segments: Array<string | FoundReference<Accepted>> = [];
  let offset = 0;
  for (const match of content.matchAll(new RegExp(REFERENCE, "giu"))) {
    const reference = decodeReference(match[0]);
    if (!reference || !accept(reference)) continue;
    if (match.index > offset) segments.push(content.slice(offset, match.index));
    offset = match.index + match[0].length;
    segments.push({ ...reference, from: match.index, to: offset });
  }
  if (offset < content.length) segments.push(content.slice(offset));
  return segments;
}
