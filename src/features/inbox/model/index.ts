import { z } from "zod";
import type { Worker } from "@workers/model";
import type { Screening, UntrustedContent } from "@security/model";
import { wrapUntrustedContent } from "@security/model/envelope";

const safePathSegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0"),
    "Must be one safe path segment",
  );

export const inboxEntryIdSchema = safePathSegmentSchema.describe("The Inbox entry ID");

const inboxArtifactPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.startsWith("~/") &&
      path.split("/").every((segment) => safePathSegmentSchema.safeParse(segment).success),
    "Must be a relative file path beneath this session's artifacts directory",
  );

export type InboxEntry = {
  id: string;
  createdAt: string;
} & (
  | { kind: "pending" }
  | { kind: "result"; message: string; artifact?: string }
  | { kind: "error"; error: string }
);

export const inboxEntryIdInputSchema = z.object({
  entryId: inboxEntryIdSchema,
});

export const inboxResultSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("The concise Inbox message to show the user"),
  artifact: inboxArtifactPathSchema
    .optional()
    .describe(
      "An existing file relative to this session's artifacts directory, such as reports/research.md. Write the file before calling this tool.",
    ),
});

export const inboxFailureSchema = z.object({
  error: z.string().trim().min(1).max(4000),
});

/** The browser page a task is about. Its title and selection are written by the page's authors. */
export const inboxPageSchema = z.object({
  url: z.string().trim().min(1),
  title: z.string().trim().optional(),
  selection: z.string().trim().optional(),
  linkUrl: z.string().trim().optional(),
  mediaUrl: z.string().trim().optional(),
});

export type InboxPage = z.infer<typeof inboxPageSchema>;

/** What the page contributes to a task, labeled with where it came from. */
export function inboxPageContent(page: InboxPage): UntrustedContent {
  return {
    source: `the web page ${page.url}`,
    text: [
      ...(page.title ? [`Page title: ${page.title}`] : []),
      `URL: ${page.url}`,
      ...(page.selection ? ["", "Selected text:", page.selection] : []),
      ...(page.linkUrl ? ["", `Linked URL: ${page.linkUrl}`] : []),
      ...(page.mediaUrl ? ["", `Media URL: ${page.mediaUrl}`] : []),
    ].join("\n"),
  };
}

/** The user's task about a page, with the page's own words kept apart as untrusted content. */
export function inboxPagePrompt(
  task: string,
  page: InboxPage,
  hasViewport: boolean,
  screening?: Screening,
): string {
  return [
    "Open and inspect the following page, then complete this background task.",
    "",
    wrapUntrustedContent(inboxPageContent(page), screening),
    ...(hasViewport
      ? ["", "The attached image shows the visible viewport at submission time."]
      : []),
    "",
    "Task:",
    task,
  ].join("\n");
}

export function inboxEntryFromWorker(worker: Extract<Worker, { type: "inbox" }>): InboxEntry {
  const entry = { id: worker.sessionId, createdAt: worker.createdAt };
  if (worker.metadata === undefined) return { ...entry, kind: "pending" };

  const result = inboxResultSchema.safeParse(worker.metadata);
  if (result.success) return { ...entry, kind: "result", ...result.data };
  const failure = inboxFailureSchema.safeParse(worker.metadata);
  if (failure.success) return { ...entry, kind: "error", ...failure.data };
  return { ...entry, kind: "error", error: "This Inbox result could not be read." };
}
