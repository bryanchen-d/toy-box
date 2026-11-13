import type { SessionToolGuard } from "@providers/server/provider";
import { actionRisk, untrustedSource } from "../model/actions";
import { approvalQuestion, refusalReason, reviewAction } from "../model/policy";
import { readOpenFinding, receiveUntrustedContent } from ".";

/** Asks whoever is watching a session to approve a held action. */
export type ApprovalRequest = (question: string, signal?: AbortSignal) => Promise<boolean>;

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
