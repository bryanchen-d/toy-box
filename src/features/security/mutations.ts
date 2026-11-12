import { mutationOptions } from "@tanstack/react-query";
import { sendSystemMessage } from "@sessions/server/functions";
import {
  closeSecurityFinding,
  explainSecurityFinding,
  reopenSecurityFinding,
} from "./server/functions";
import { applySecurityFindingEvent } from "./queryCache";
import type { FindingExchange, FindingOutcome, SecurityFinding } from "./model";

export const securityMutations = {
  close: (findingId: string) =>
    mutationOptions({
      mutationFn: (outcome: FindingOutcome) =>
        closeSecurityFinding({ data: { findingId, outcome } }),
      onSuccess: (finding, _variables, _onMutateResult, { client }) =>
        applySecurityFindingEvent(client, { type: "security.finding.upserted", finding }),
    }),

  reopen: (findingId: string) =>
    mutationOptions({
      mutationFn: () => reopenSecurityFinding({ data: { findingId } }),
      onSuccess: (finding, _variables, _onMutateResult, { client }) =>
        applySecurityFindingEvent(client, { type: "security.finding.upserted", finding }),
    }),

  /** Tell the session's agent the content was an injection, and not to act on it. */
  warn: ({ sessionId, source, action }: SecurityFinding) =>
    mutationOptions({
      mutationFn: () =>
        sendSystemMessage({
          data: { sessionId, message: { type: "security_warning", source, action } },
        }),
    }),

  explain: (findingId: string) =>
    mutationOptions({
      mutationFn: ({ question, earlier }: { question: string; earlier: FindingExchange[] }) =>
        explainSecurityFinding({ data: { findingId, question, earlier } }),
    }),
};
