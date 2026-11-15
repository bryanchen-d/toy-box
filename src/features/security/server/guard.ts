import type { SessionToolGuard } from "@providers/server/provider";
import { sharedMap } from "@/shared/server/processState";
import { actionRisk, describeAction, firstLine, untrustedSource } from "../model/actions";
import { approvalQuestion, refusalReason, reviewAction } from "../model/policy";
import { readOpenFinding, receiveUntrustedContent } from ".";

/** Asks whoever is watching a session to approve a held action. */
export type ApprovalRequest = (question: string, signal?: AbortSignal) => Promise<boolean>;

const WRITES_PER_SESSION = 50;
/** Sessions nobody takes writes from, such as the owner's own, drop out oldest first. */
const SESSIONS_WITH_WRITES = 200;
const externalWrites = sharedMap<string[]>("security-external-writes");

/**
 * One session's tool guard. Without `ask`, nobody can approve held actions, so they're refused.
 */
export function createSessionGuard(sessionId: string, ask?: ApprovalRequest): SessionToolGuard {
  return {
    async review(action, signal) {
      // Most calls carry no risk, so they never wait for the database.
      if (!actionRisk(action)) return { allowed: true };
      const review = reviewAction(action, await readOpenFinding(sessionId), ask !== undefined);
      if (review.decision === "allow") return { allowed: true };
      if (review.decision === "ask" && (await ask!(approvalQuestion(action, review), signal)))
        return { allowed: true };
      return {
        allowed: false,
        reason: refusalReason(review, review.decision === "ask" ? "declined" : "unattended"),
      };
    },
    async screen(action, result, saved) {
      const risk = actionRisk(action);
      if (risk?.kind === "send") {
        recordExternalWrite(
          sessionId,
          `${risk.description}: ${firstLine(describeAction(action), 200)}`,
        );
      }
      const source = untrustedSource(action);
      if (!source) return result;
      return receiveUntrustedContent(
        sessionId,
        {
          source,
          text: saved ?? result,
          ...(action.type === "command" ? { command: action.command } : {}),
        },
        saved === undefined ? undefined : result,
      );
    },
  };
}

/**
 * The external writes, such as pushes and pull request changes, that ran in a session since they
 * were last taken, oldest first. Each may still have failed.
 */
export function takeExternalWrites(sessionId: string): string[] {
  const writes = externalWrites.get(sessionId) ?? [];
  externalWrites.delete(sessionId);
  return writes;
}

function recordExternalWrite(sessionId: string, write: string): void {
  const writes = externalWrites.get(sessionId) ?? [];
  // Reinserting keeps the most recently active sessions last, so the oldest drop out first.
  externalWrites.delete(sessionId);
  externalWrites.set(sessionId, [...writes, write].slice(-WRITES_PER_SESSION));
  if (externalWrites.size > SESSIONS_WITH_WRITES) {
    externalWrites.delete(externalWrites.keys().next().value!);
  }
}
