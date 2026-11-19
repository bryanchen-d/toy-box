// An owner's sub sessions as the workspace presents them: a list of each one's place and state, a
// count on the owner's avatar, the owners whose sub sessions are at work, and those on pool nodes.

import { useQuery } from "@tanstack/react-query";
import { providerNode } from "@providers/model";
import type { Session } from "@sessions/model";
import { selectSessionChildren, sessionQueries } from "@sessions/queries";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { useWorkspaceSelector, useWorkspaceSessionActivity } from "@workspace/hooks/state";
import type { WorkspaceState } from "@workspace/model/state/reducer";
import { RelativeTime } from "@/shared/ui/relative-time";
import { cn } from "@/shared/utils";
import { describeSubSessions } from "../model/subSessions";

const NO_SUB_SESSIONS: readonly Session[] = [];

/** The sessions an owner created to do one task each. */
export function useSubSessions(ownerId: string): readonly Session[] {
  const { data } = useQuery({
    ...sessionQueries.state(),
    select: (state) => selectSessionChildren(state)[ownerId] ?? NO_SUB_SESSIONS,
  });
  return data ?? NO_SUB_SESSIONS;
}

export type SubSessionSummary = { count: number; working: number; label: string };

/** How many sub sessions an owner has and how many are at work, with one line saying so. */
export function useSubSessionSummary(ownerId: string): SubSessionSummary | undefined {
  const subSessions = useSubSessions(ownerId);
  const working = useWorkspaceSelector((workspace) =>
    subSessions.filter(({ id }) => isAtWork(workspace, id)).map(({ id }) => id),
  );
  if (subSessions.length === 0) return undefined;
  return {
    count: subSessions.length,
    working: working.length,
    label: describeSubSessions(
      subSessions.map(({ id, provider }) => ({
        working: working.includes(id),
        node: providerNode(provider?.id),
      })),
    ),
  };
}

/** The owners with a sub session at work, who are busy even while they wait for it. */
export function useOwnersOfWorkingSubSessions(): readonly string[] {
  const { data: ownership } = useQuery({
    ...sessionQueries.state(),
    select: (state) => state.ownership,
  });
  return useWorkspaceSelector((workspace) => {
    const owners = new Set<string>();
    for (const [sessionId, owner] of Object.entries(ownership ?? {})) {
      if (owner.type === "worker" && owner.parentSessionId && isAtWork(workspace, sessionId)) {
        owners.add(owner.parentSessionId);
      }
    }
    return [...owners].sort();
  });
}

/** A count on an owner's avatar of its sub sessions, filled while any of them is at work. Its
 *  owner names the summary itself, so the count stays out of the accessibility tree. */
export function SubSessionBadge({
  summary,
  className,
}: {
  summary: SubSessionSummary | undefined;
  className?: string;
}) {
  if (!summary) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -right-1 -bottom-0.5 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[9px] font-semibold leading-none tabular-nums ring-2 ring-[var(--surface-background,var(--color-panel))]",
        summary.working > 0
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground",
        className,
      )}
    >
      {summary.count}
    </span>
  );
}

/** An owner's sub sessions beneath its read-only transcript, as its hover preview shows it. */
export function SubSessionSection({ ownerId }: { ownerId: string }) {
  const subSessions = useSubSessions(ownerId);
  if (subSessions.length === 0) return null;
  return (
    <section
      aria-label="Sub sessions"
      className="max-h-48 shrink-0 overflow-y-auto border-t bg-panel px-4 py-3 text-xs"
    >
      <h3 className="mb-2 font-medium text-muted-foreground">
        Sub sessions ({subSessions.length})
      </h3>
      <SubSessionList sessions={subSessions} />
    </section>
  );
}

/** Sub sessions oldest first, each with where it runs and what it's doing; each opens beside its
 *  owner. */
export function SubSessionList({ sessions }: { sessions: readonly Session[] }) {
  if (sessions.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <ul className="space-y-1">
      {[...sessions]
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map((session) => (
          <SubSessionItem key={session.id} session={session} />
        ))}
    </ul>
  );
}

function SubSessionItem({ session }: { session: Session }) {
  const { openSession } = useWorkspaceSurface();
  const title = session.title || "Sub session";
  return (
    <li>
      {openSession ? (
        <button
          type="button"
          className="text-left hover:underline"
          title={`Open ${title}`}
          onClick={() => openSession(session.id)}
        >
          {title}
        </button>
      ) : (
        title
      )}
      <SubSessionStatus session={session} className="block" />
    </li>
  );
}

/** Where a sub session runs and what it's doing, such as "On brchen-db3 · Working". */
export function SubSessionStatus({ session, className }: { session: Session; className?: string }) {
  const activity = useWorkspaceSessionActivity(session.id);
  const node = providerNode(session.provider?.id);
  return (
    <span className={cn("text-muted-foreground", className)}>
      {node ? `On ${node} · ` : null}
      {activity.waiting ? (
        "Waiting for input"
      ) : activity.background ? (
        "Background tasks running"
      ) : activity.running ? (
        "Working"
      ) : (
        <>
          Idle · <RelativeTime date={session.updatedAt} />
        </>
      )}
    </span>
  );
}

export type NodeSubSession = { session: Session; ownerSessionId: string; working: boolean };

/** The open sub sessions on any of these pool nodes, each with its owner and whether it's at work. */
export function useNodeSubSessions(nodes: readonly string[]): NodeSubSession[] {
  const { data: onNodes = [] } = useQuery({
    ...sessionQueries.state(),
    select: (state) =>
      state.sessions.flatMap((session) => {
        const node = providerNode(session.provider?.id);
        const owner = state.ownership[session.id];
        return node !== undefined &&
          nodes.includes(node) &&
          owner?.type === "worker" &&
          owner.parentSessionId
          ? [{ session, ownerSessionId: owner.parentSessionId }]
          : [];
      }),
  });
  const working = useWorkspaceSelector((workspace) =>
    onNodes
      .filter(({ session }) => isAtWork(workspace, session.id))
      .map(({ session }) => session.id),
  );
  return onNodes.map((entry) => ({ ...entry, working: working.includes(entry.session.id) }));
}

function isAtWork(workspace: WorkspaceState, sessionId: string): boolean {
  const status = workspace.sessionStates[sessionId]?.status;
  return status === "running" || status === "waiting" || status === "background";
}
