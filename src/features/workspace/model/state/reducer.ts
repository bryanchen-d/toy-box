import type { CustomEditorKind } from "@files/model";
import { workerReferencesSession, type Worker } from "@workers/model";
import { areSettingsEqual, DEFAULT_SETTINGS, type Settings } from "../config/settings";
import type { WorkspaceEvent } from "../events";
import { sameSavedDraft, type DraftKey, type SavedDrafts } from "./drafts";

/** The complete shared workspace projection assembled by the server and reduced by clients. */
export type WorkspaceState = {
  settings: Settings;
  sessionStates: Record<string, WorkspaceSessionState>;
  /** Each composer's unsent text, shared across clients. */
  drafts: SavedDrafts;
  hyperSessionIds: string[];
  workers: Worker[];
  customEditors: CustomEditorKind[];
  environment: WorkspaceEnvironment;
};

/** Passive capabilities configured by the server process. */
export type WorkspaceEnvironment = {
  voiceEnabled: boolean;
};

/**
 * Shared lifecycle for one session. Missing means idle.
 * A live session remembers `since`, when its current run began.
 */
export type WorkspaceSessionState =
  | { status: "running" | "waiting"; since: number }
  | { status: "unread" };

/** A session's shared status, including idle, which has no stored state. */
export type WorkspaceSessionStatus = WorkspaceSessionState["status"] | "idle";

export function createEmptyWorkspaceState(): WorkspaceState {
  return {
    settings: DEFAULT_SETTINGS,
    sessionStates: {},
    drafts: {},
    hyperSessionIds: [],
    workers: [],
    customEditors: [],
    environment: { voiceEnabled: false },
  };
}

export function reduceWorkspaceState(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case "settings.changed":
      return areSettingsEqual(state.settings, event.settings)
        ? state
        : { ...state, settings: event.settings };
    case "session.deleted": {
      const next = reduceSessionInWorkspace(state, event.sessionId, event);
      const withoutHyper = setHyperSessionMembership(next, event.sessionId, false);
      const withoutWorkers = removeWorkers(withoutHyper, (worker) =>
        workerReferencesSession(worker, event.sessionId),
      );
      return removeDraft(withoutWorkers, `session:${event.sessionId}`);
    }
    case "channel.deleted":
      return removeDraft(state, `channel:${event.channelId}`);
    case "draft.changed":
      return sameSavedDraft(state.drafts[event.key], event.draft)
        ? state
        : { ...state, drafts: { ...state.drafts, [event.key]: event.draft } };
    case "session.hyper.promoted":
      return setHyperSessionMembership(state, event.sessionId, false);
    case "session.running":
    case "session.waiting":
    case "session.idle":
    case "session.unread":
    case "session.read":
      return reduceSessionInWorkspace(state, event.sessionId, event);
    case "session.upserted":
      return event.session.sessionType === "hyper"
        ? setHyperSessionMembership(state, event.session.id, true)
        : state;
    case "editor.registered": {
      const index = state.customEditors.findIndex((kind) => kind.name === event.kind.name);
      if (state.customEditors[index] === event.kind) return state;
      const customEditors = [...state.customEditors];
      if (index === -1) customEditors.push(event.kind);
      else customEditors[index] = event.kind;
      return { ...state, customEditors };
    }
    case "app.deleted":
      return removeWorkers(
        state,
        (worker) => worker.type === "app" && worker.appId === event.appId,
      );
    case "worker.started":
      return state.workers.some((worker) => worker.sessionId === event.worker.sessionId)
        ? state
        : { ...state, workers: [...state.workers, event.worker] };
    case "worker.finished":
      return removeWorkers(state, (worker) => worker.sessionId === event.sessionId);
    default:
      return state;
  }
}

export type WorkspaceSessionEvent = Extract<
  WorkspaceEvent,
  {
    type:
      | "session.running"
      | "session.waiting"
      | "session.idle"
      | "session.unread"
      | "session.read"
      | "session.deleted";
  }
>;

/** The canonical transition function shared by the server store and client projection. */
export function reduceWorkspaceSessionState(
  state: WorkspaceSessionState | undefined,
  event: WorkspaceSessionEvent,
): WorkspaceSessionState | undefined {
  switch (event.type) {
    case "session.running":
    case "session.waiting": {
      const status = event.type === "session.running" ? "running" : "waiting";
      if (state?.status === status) return state;
      // Waiting is a pause within the same run, so moving between the live states keeps its start.
      const since =
        state?.status === "running" || state?.status === "waiting" ? state.since : event.at;
      return { status, since };
    }
    case "session.idle":
      return undefined;
    case "session.unread":
      return state?.status === "unread" ? state : { status: "unread" };
    case "session.read":
      return state?.status === "unread" ? undefined : state;
    case "session.deleted":
      return undefined;
  }
}

export function isWorkspaceSessionLive(status: WorkspaceSessionStatus | undefined): boolean {
  return status === "running" || status === "waiting";
}

function reduceSessionInWorkspace(
  workspace: WorkspaceState,
  sessionId: string,
  event: WorkspaceSessionEvent,
): WorkspaceState {
  const current = workspace.sessionStates[sessionId];
  const next = reduceWorkspaceSessionState(current, event);
  if (next === current) return workspace;

  if (!next) {
    if (!current) return workspace;
    const { [sessionId]: _, ...sessionStates } = workspace.sessionStates;
    return { ...workspace, sessionStates };
  }

  return {
    ...workspace,
    sessionStates: { ...workspace.sessionStates, [sessionId]: next },
  };
}

function removeDraft(state: WorkspaceState, key: DraftKey): WorkspaceState {
  if (!state.drafts[key]) return state;
  const { [key]: _, ...drafts } = state.drafts;
  return { ...state, drafts };
}

function setHyperSessionMembership(
  state: WorkspaceState,
  sessionId: string,
  present: boolean,
): WorkspaceState {
  const hasSessionId = state.hyperSessionIds.includes(sessionId);
  if (present === hasSessionId) return state;

  return {
    ...state,
    hyperSessionIds: present
      ? [...state.hyperSessionIds, sessionId]
      : state.hyperSessionIds.filter((id) => id !== sessionId),
  };
}

function removeWorkers(state: WorkspaceState, remove: (worker: Worker) => boolean): WorkspaceState {
  const workers = state.workers.filter((worker) => !remove(worker));
  return workers.length === state.workers.length ? state : { ...state, workers };
}
