// Providers adapt native histories and live activity to Sessions' domain model.
// Sessions supplies host policy and resources, and owns queues and completion.

import type { ModelConfiguration, ModelInfo, ProviderSubscription } from "@providers/model";
import type { AgentAction } from "@security/model";
import type { SessionEvent, SessionMessage, Session, SessionSkill } from "@sessions/model";
import type { SessionQuestionAnswer } from "@sessions/model/protocol";
import type { Tool } from "@sessions/server/tools/definition";

/** The operation was not submitted; reacquiring the connection is safe. */
export class SessionConnectionUnavailableError extends Error {}

/**
 * Agent Teams' review of native tool activity. Providers translate native calls into actions and
 * apply it from their native hooks, as far as each one allows.
 */
export interface SessionToolGuard {
  /** Whether a tool call may run; a refusal's reason reaches the model in place of its result. */
  review(
    action: AgentAction,
    signal?: AbortSignal,
  ): Promise<{ allowed: true } | { allowed: false; reason: string }>;
  /**
   * The text the model should read for a tool's result: the same, or marked untrusted. When the
   * model reads only a notice that the provider saved the full result elsewhere, `saved` is that
   * full result, which is what gets judged.
   */
  screen(action: AgentAction, result: string, saved?: string): Promise<string>;
}

export type SessionConfiguration = {
  model?: ModelConfiguration;
  directory: string;
  allowUserQuestions: boolean;
  tools: Tool<any>[];
  instructions: string;
  skillDirectories: string[];
  toolGuard: SessionToolGuard;
  disableMemory?: boolean;
};

/** One prompt answered by a model with no tools and no retained history. */
export type ProviderPrompt = {
  model: string;
  instructions: string;
  prompt: string;
  signal?: AbortSignal;
};

/** One attached native session, independent of browser observation. */
export interface SessionConnection {
  readonly provider: NonNullable<Session["provider"]>;
  /** The runtime consumes end to drain queued work before publishing completion. */
  onEvent(listener: (event: SessionEvent) => void): () => void;
  send(message: SessionMessage): Promise<void>;
  setModel(model: ModelConfiguration): Promise<void>;
  answerQuestion(answer: SessionQuestionAnswer): Promise<boolean>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  rename(name: string, automatic?: true): Promise<boolean>;
  rewind(timestamp: string): Promise<void>;
}

/** Providers reuse the supplied session ID when supported; native overrides remain opaque. */
export interface SessionProvider {
  readonly id: string;
  readonly name: string;
  listModels(): Promise<ModelInfo[]>;
  /** Read the signed-in account's subscription; an account using an API key has none. */
  readSubscription(): Promise<ProviderSubscription | undefined>;
  /** Answer a one-off prompt for Agent Teams' own judgments. Providers that can't omit it. */
  respond?(prompt: ProviderPrompt): Promise<string>;
  listSkills(
    directory: string | undefined,
    skillDirectories: readonly string[],
  ): Promise<SessionSkill[]>;
  listSessions(): Promise<Session[]>;
  /** Read durable history without resuming or acquiring the native session. */
  readHistory(session: Pick<Session, "id" | "provider">): Promise<SessionEvent[]>;
  create(
    sessionId: string,
    configuration: SessionConfiguration & { name?: string },
  ): Promise<SessionConnection>;
  resume(
    session: Pick<Session, "id" | "provider">,
    configuration: SessionConfiguration,
  ): Promise<SessionConnection>;
  readDirectory(nativeId: string): Promise<string | undefined>;
  /** The provider owns persistence precision and any trailing-flush policy. */
  isHistoryCurrent(nativeId: string, capturedAt: number): Promise<boolean>;
  delete(nativeId: string): Promise<void>;
  stop(): Promise<void>;
}
