import { useState } from "react";
import { UserPlus, Users } from "lucide-react";
import type { ChannelMember } from "@channels/model";
import { CompletionMenu } from "@/shared/composers/completions/CompletionMenu";
import type { Completions } from "@/shared/composers/completions/useCompletions";
import { AgentAvatar } from "./AgentAvatar";
import { AgentEditor } from "./AgentEditor";
import type { AgentCompletionItem } from "./agentCompletionSource";

/** The agent mention menu; the editor dialog outlives the menu it was opened from. */
export function AgentCompletionMenu({
  completions,
}: {
  completions: Completions<AgentCompletionItem>;
}) {
  const [editingAgent, setEditingAgent] = useState<ChannelMember>();

  return (
    <>
      <CompletionMenu
        completions={completions}
        label="Mention an agent"
        icon={(item) =>
          item.kind === "everyone" ? (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-cyan-700 dark:text-cyan-300">
              <Users className="size-3.5" />
            </span>
          ) : item.kind === "create" ? (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UserPlus className="size-3.5" />
            </span>
          ) : (
            <AgentAvatar agent={{ name: item.label, avatar: item.avatar }} className="size-7" />
          )
        }
        edit={({ agent }) => agent && (() => setEditingAgent(agent))}
      />
      {editingAgent && (
        <AgentEditor agent={editingAgent} onClose={() => setEditingAgent(undefined)} />
      )}
    </>
  );
}
