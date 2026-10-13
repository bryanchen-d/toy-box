import {
  getSessionMessages,
  getSubagentMessages,
  importSessionToStore,
  listSubagents,
  type SDKMessage,
  type SessionMessage,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

/** One read of native history; the SDK owns file discovery and active-branch reconstruction.
 * getSessionMessages omits structured tool results, effort, and API errors. Its export API
 * supplies those records to this request-local buffer; nothing is mirrored, cached, or
 * persisted by this provider. */
export async function readClaudeHistory(nativeId: string): Promise<SDKMessage[]> {
  const transcripts = new Map<string, SessionStoreEntry[]>();
  const records = new Map<string, SessionStoreEntry>();
  const source: SessionStore = {
    async append({ subpath = "" }, entries) {
      const transcript = transcripts.get(subpath) ?? [];
      transcript.push(...entries);
      transcripts.set(subpath, transcript);
      for (const entry of entries) if (entry.uuid) records.set(entry.uuid, entry);
    },
    async load({ subpath = "" }) {
      return transcripts.get(subpath) ?? null;
    },
    async listSubkeys() {
      return [...transcripts.keys()].filter(Boolean);
    },
  };
  await importSessionToStore(nativeId, source);
  const options = { sessionStore: source };
  const root = await getSessionMessages(nativeId, options);
  const children = await Promise.all(
    (await listSubagents(nativeId, options)).map((id) =>
      getSubagentMessages(nativeId, id, options),
    ),
  );
  const restore = (messages: SessionMessage[]) =>
    messages.map((message) => {
      const record = records.get(message.uuid);
      return {
        ...message,
        tool_use_result: record?.toolUseResult,
        effort: record?.effort,
        error: record?.error,
      } as SDKMessage;
    });
  return [...asLiveStream(restore(root)), ...restore(children.flat())];
}

// The CLI records Toy Box's model switches as this command, in native history only.
const MODEL_SWITCH = /^<command-name>\/model<\/command-name>/;

/** Replays native history as the live stream sent it. History keeps no turn results: as in the CLI,
 * a turn whose last assistant message is an API error failed with it, so that result is restored.
 * History also records each model switch as a `/model` command the live stream never sends. */
export function asLiveStream(messages: SDKMessage[]): SDKMessage[] {
  return messages.flatMap((message, index) => {
    if (
      message.type === "user" &&
      typeof message.message.content === "string" &&
      MODEL_SWITCH.test(message.message.content)
    )
      return [];
    if (message.type === "assistant" && message.error && messages[index + 1]?.type !== "assistant")
      return [
        message,
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: message.message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n"),
        } as SDKMessage,
      ];
    return [message];
  });
}

// Workaround (Claude Agent SDK 0.3.296; listed in providers/AGENTS.md): session info reads `cwd`
// only from a transcript's first 64 KB, so a large first message, such as a pasted image, hides
// it. Read the first entry that records one instead; remove once `getSessionInfo()` finds it.
export async function readTranscriptDirectory(nativeId: string): Promise<string | undefined> {
  let directory: string | undefined;
  const found = new Error("Found the transcript directory.");
  try {
    await importSessionToStore(
      nativeId,
      {
        async append(_key, entries) {
          const cwd = entries.find((entry) => typeof entry.cwd === "string")?.cwd;
          if (typeof cwd !== "string") return;
          directory = cwd;
          // Stop reading the transcript once its directory is known.
          throw found;
        },
        load: async () => null,
      },
      { includeSubagents: false, batchSize: 8 },
    );
  } catch (error) {
    if (error !== found) throw error;
  }
  return directory;
}
