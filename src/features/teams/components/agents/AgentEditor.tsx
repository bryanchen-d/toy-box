import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import {
  createTeamMemberInputSchema,
  updateTeamMemberInputSchema,
  type TeamMember,
} from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { OptionalModelConfigurationPicker } from "@providers/components/ModelPicker";
import { areModelConfigurationsEqual, type ModelConfiguration } from "@providers/model";
import { sessionQueries } from "@sessions/queries";
import { useModels } from "@providers/useModels";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { DestructiveConfirmationDialog } from "@/shared/sidebar/DestructiveConfirmationDialog";
import { Textarea } from "@/shared/ui/textarea";
import { CopyTeamUri } from "../CopyTeamUri";
import { AgentAvatar } from "./AgentAvatar";

/** Edits a member, or adds a new one to a Team when given only the Team. */
type AgentEditorProps = { onClose: () => void } & (
  | { agent: TeamMember; teamId?: never }
  | { agent?: never; teamId: string }
);

export function AgentEditor(props: AgentEditorProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-h-[min(50rem,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
        <AgentForm key={props.agent?.id} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function AgentForm({ agent, teamId, onClose }: AgentEditorProps) {
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [model, setModel] = useState<ModelConfiguration | undefined>(agent?.model);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { data: sessionProvider } = useQuery({
    ...sessionQueries.state(),
    select: (state) => state.sessions.find(({ id }) => id === agent?.id)?.provider?.id,
  });
  const provider = sessionProvider ?? agent?.model?.provider;
  const { models, defaultModel } = useModels(provider);
  const inheritedModel = !provider || defaultModel?.provider === provider ? defaultModel : null;
  const update = useMutation(teamMutations.updateMember());
  const create = useMutation(teamMutations.createMember());
  const { isPending, error } = agent ? update : create;
  const nextName = name.trim();
  const nextRole = role.trim();
  const input = agent
    ? updateTeamMemberInputSchema.safeParse({
        agentId: agent.id,
        ...(nextName !== agent.name ? { name: nextName } : {}),
        ...(nextRole !== (agent.role ?? "") ? { role: nextRole } : {}),
        ...(!areModelConfigurationsEqual(model, agent.model) ? { model: model ?? null } : {}),
      })
    : createTeamMemberInputSchema.safeParse({
        teamId,
        name: nextName,
        ...(nextRole ? { role: nextRole } : {}),
        ...(model ? { model } : {}),
      });
  const canSubmit = input.success && !isPending;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!input.success || isPending) return;
    if ("agentId" in input.data) update.mutate(input.data, { onSuccess: onClose });
    else create.mutate(input.data, { onSuccess: onClose });
  }

  return (
    <>
      {agent ? (
        <div className="flex items-center gap-1">
          <DialogTitle className="flex items-center gap-2.5">
            <AgentAvatar agent={agent} className="size-9" />
            {agent.name}
          </DialogTitle>
          <CopyTeamUri
            variant="button"
            target={{ type: "agent", teamId: agent.teamId, agentId: agent.id }}
            label="Copy agent URI"
          />
        </div>
      ) : (
        <DialogTitle className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <UserPlus className="size-4" />
          </span>
          New agent
        </DialogTitle>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Name" hint="Names are unique within this team and determine mentions.">
          <Input
            autoFocus={!agent}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field
          label="Role"
          hint={
            agent
              ? "The member's responsibility in this team, plus any necessary persona or behavioral details."
              : "Optional. The member's responsibility in this team, plus any necessary persona or behavioral details. Left empty, the agent writes its own from the team's context."
          }
        >
          <Textarea
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder="A direct product critic who tests assumptions against concrete user experience and explains tradeoffs clearly."
            className="min-h-32"
            required={agent?.role !== undefined}
          />
        </Field>
        <div className="grid gap-1.5 text-sm font-medium">
          <span>Model</span>
          <div className="flex min-h-10 items-center gap-1 rounded-md border px-1.5">
            <OptionalModelConfigurationPicker
              models={models}
              value={model}
              inheritedValue={inheritedModel}
              onValueChange={setModel}
            />
          </div>
          {agent && (
            <span className="text-xs font-normal text-muted-foreground">
              Model changes apply on the agent&apos;s next turn.
            </span>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        <DialogFooter>
          {agent && (
            <Button
              type="button"
              variant="destructive-ghost"
              className="sm:mr-auto"
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 /> Remove agent
            </Button>
          )}
          <Button type="submit" disabled={!canSubmit}>
            {agent ? (isPending ? "Saving…" : "Save agent") : isPending ? "Adding…" : "Add agent"}
          </Button>
        </DialogFooter>
      </form>

      {agent && confirmingDelete && (
        <DestructiveConfirmationDialog
          title={`Remove ${agent.name}?`}
          description={`This removes ${agent.name} from the team and deletes their private team session and assigned routines. Their messages and reactions remain attributed to Deleted agent.`}
          confirmLabel="Remove agent"
          pendingLabel="Removing…"
          mutation={teamMutations.removeMember(agent.id)}
          onSubmit={onClose}
          onOpenChange={setConfirmingDelete}
        />
      )}
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm font-medium">
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </label>
  );
}
