import { getPathBasename } from "@files/model/paths";
import type { Reference } from "@/shared/references";
import type { Session } from "./index";

const kinds = ["session", "file"] as const;

/** The references a session prompt carries. Labels are display snapshots, never lookup keys. */
export type PromptReference = Reference & { kind: (typeof kinds)[number] };

export function sessionReference(session: Pick<Session, "id" | "title">): PromptReference {
  return { kind: "session", target: session.id, label: session.title || session.id };
}

/** A path as returned by directory search, resolved by the receiving session's directory. */
export function fileReference(path: string): PromptReference {
  return { kind: "file", target: path, label: getPathBasename(path) };
}

/** Recognizes Sessions' kinds; other hosts' kinds remain ordinary text. */
export function isPromptReference(reference: Reference): reference is PromptReference {
  return (kinds as readonly string[]).includes(reference.kind);
}
