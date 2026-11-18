import type { CopilotSession, SessionEvent as SdkEvent } from "@github/copilot-sdk";
import type { ModelConfiguration } from "@providers/model";
import {
  SessionConnectionUnavailableError,
  type SessionConnection,
} from "@providers/server/provider";
import { encodeSystemMessage, systemMessagePrompt } from "@sessions/model/systemMessages";
import { toSdkAttachments } from "./attachments";
import { toSdkSetModelOptions } from "./modelConfiguration";
import { createSdkEventProjector } from "./projector";

const CLIENT_STOPPED = "The Copilot client stopped.";

/**
 * Native SDK event and RPC details never cross the Sessions contract. Once the client serving
 * `native` stops, its live turn ends, and subscribing, sending, renaming, and rewinding report the
 * connection unavailable, so Sessions resumes the session through the next client.
 */
export function connectCopilotSession(
  native: CopilotSession,
  sessionId: string,
  clientStopped: AbortSignal,
  appliedModel?: ModelConfiguration,
): SessionConnection {
  const pendingInputs = new Map<string, string>();
  const assertAvailable = () => {
    if (clientStopped.aborted) throw new SessionConnectionUnavailableError(CLIENT_STOPPED);
  };
  return {
    provider: { id: "copilot", sessionId: native.sessionId ?? sessionId },
    onEvent(listener) {
      assertAvailable();
      // Native start and resume events predate subscription; seed the live stream with their model.
      if (appliedModel) listener({ type: "model_changed", model: appliedModel });
      const project = createSdkEventProjector(sessionId);
      const unsubscribe = native.on((event: SdkEvent) => {
        if (event.type === "session.idle") {
          listener({ type: "end", reason: "idle" });
          return;
        }
        if (event.type === "abort") {
          listener({ type: "end", reason: "error" });
          return;
        }
        for (const projected of project(event)) {
          if (
            (projected.type === "user_message" || projected.type === "system_message") &&
            event.type === "user.message"
          ) {
            const clientId = event.data.messageId
              ? pendingInputs.get(event.data.messageId)
              : undefined;
            if (clientId) {
              pendingInputs.delete(event.data.messageId!);
              listener({ ...projected, clientId });
              continue;
            }
          }
          listener(projected);
        }
      });
      const end = () => listener({ type: "end", reason: "error", error: CLIENT_STOPPED });
      clientStopped.addEventListener("abort", end);
      return () => {
        clientStopped.removeEventListener("abort", end);
        unsubscribe();
      };
    },
    async send(message) {
      assertAvailable();
      const id = await native.send({
        ...(message.role === "system"
          ? {
              prompt: systemMessagePrompt(message.content),
              displayPrompt: encodeSystemMessage(message.content),
              source: "system",
            }
          : {
              prompt: message.content,
              attachments: toSdkAttachments(message.attachments),
            }),
        ...(message.immediate ? { mode: "immediate" } : {}),
      });
      pendingInputs.set(id, message.clientId);
    },
    async setModel(model: ModelConfiguration) {
      await native.setModel(model.name, toSdkSetModelOptions(model));
    },
    async answerQuestion({ requestId, answer, wasFreeform }) {
      return (
        await native.rpc.ui.handlePendingUserInput({ requestId, response: { answer, wasFreeform } })
      ).success;
    },
    async abort() {
      try {
        await native.rpc.queue.clear();
      } finally {
        await native.abort();
      }
    },
    disconnect: () => native.disconnect(),
    async rename(name, automatic) {
      assertAvailable();
      if (automatic) return (await native.rpc.name.setAuto({ summary: name })).applied;
      await native.rpc.name.set({ name });
      return true;
    },
    async rewind(timestamp) {
      assertAvailable();
      const { points } = await native.rpc.history.listRewindPoints();
      const point = points.find((candidate) => candidate.timestamp === timestamp);
      if (!point) throw new Error("That message is no longer available to rewind.");
      const { eventsRemoved } = await native.rpc.history.rewind({
        eventId: point.eventId,
        mode: "conversation",
      });
      if (eventsRemoved === undefined) throw new Error("Session rewind failed.");
    },
  };
}
