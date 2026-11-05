import {
  isTeamSystemMessage,
  type TeamArtifact,
  type TeamMessage,
  type TeamConversationMessage,
  type TeamEvent,
} from "@teams/model";
import { machineFile, workspaceFileId } from "@files/model";
import { createFileServeUrl, getPathBasename } from "@files/model/paths";
import type { StoredAttachment, StoredTeamMessage } from "./database";

/** The identity tasks reference as `artifactId`, plus the address that serves the file. */
export function resolveArtifactResources<Artifact extends Pick<TeamArtifact, "file">>(
  artifact: Artifact,
) {
  return {
    ...artifact,
    id: workspaceFileId(artifact.file),
    url: createFileServeUrl(artifact.file),
  };
}

/** Resolve client file addresses at the protocol boundary; stored paths stay server-side. */
export function resolveMessageResources(
  message: TeamConversationMessage<StoredAttachment>,
): TeamConversationMessage;
export function resolveMessageResources(message: StoredTeamMessage): TeamMessage;
export function resolveMessageResources(message: StoredTeamMessage): TeamMessage {
  if (isTeamSystemMessage(message)) {
    if (message.content.type !== "artifact_shared") return message;
    return {
      ...message,
      content: {
        ...message.content,
        artifact: resolveArtifactResources(message.content.artifact),
      },
    };
  }
  const { attachments, ...rest } = message;
  return {
    ...rest,
    ...(attachments
      ? {
          attachments: attachments.map((attachment) =>
            typeof attachment === "string"
              ? {
                  name: getPathBasename(attachment),
                  url: createFileServeUrl(machineFile(attachment)),
                }
              : attachment,
          ),
        }
      : {}),
  };
}

export function resolveEventResources(event: TeamEvent<StoredAttachment>): TeamEvent {
  switch (event.type) {
    case "message":
      return { ...event, message: resolveMessageResources(event.message) };
    case "artifacts":
      return { ...event, artifacts: event.artifacts.map(resolveArtifactResources) };
    default:
      return event;
  }
}
