import type { AppDefinition, AppInstance, AppShare } from "@apps/model";
import type { Automation } from "@automations/model";
import type { ConnectorEntry } from "@connectors/model";
import type { CustomEditorKind } from "@files/model";
import type { SessionUpdate } from "@sessions/model";
import type { WorkerEvent } from "@workers/model";
import type { Team, TeamList } from "@teams/model";
import type { Settings } from "./config/settings";
import type { WorkspaceAction } from "./state/actions";

/** Shared updates broadcast from the server to every connected workspace. */
export type WorkspaceEvent =
  | WorkspaceAction
  | WorkerEvent
  | { type: "workspace.connected"; revision: string }
  | { type: "providers.changed" }
  | { type: "team.upserted"; team: Team }
  | { type: "team.deleted"; teamId: string }
  | { type: "team.member.upserted"; member: TeamList["members"][number] }
  | { type: "team.member.deleted"; teamId: string; agentId: string }
  | {
      type: "settings.changed";
      settings: Settings;
    }
  | {
      type: "session.upserted";
      session: SessionUpdate;
    }
  | {
      type: "session.running" | "session.waiting" | "session.background";
      sessionId: string;
      at: number;
    }
  | SimpleSessionUpdateEvents<"deleted" | "idle" | "unread" | "touched">
  | { type: "inbox.changed" }
  | {
      type: "inbox.entry.deleted";
      entryId: string;
    }
  | {
      type: "editor.registered";
      kind: CustomEditorKind;
    }
  | {
      type: "app.registered";
      definition: AppDefinition;
    }
  | {
      type: "app.unregistered";
      definitionId: string;
    }
  | {
      type: "app.upserted";
      app: AppInstance;
    }
  | {
      type: "app.deleted";
      appId: string;
    }
  | {
      type: "app.share.created";
      share: AppShare;
    }
  | {
      type: "app.share.deleted";
      shareId: string;
    }
  | {
      type: "automation.upserted";
      automation: Automation;
    }
  | {
      type: "automation.deleted";
      automationId: string;
    }
  | {
      type: "connector.upserted";
      connector: ConnectorEntry;
    }
  | {
      type: "connector.deleted";
      connectorId: string;
    };

type SimpleSessionUpdateEvents<EventName extends string> = EventName extends string
  ? {
      type: `session.${EventName}`;
      sessionId: string;
    }
  : never;
