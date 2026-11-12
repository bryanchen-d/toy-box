// The findings record and the user's commands on it for UI clients.

import { createServerFn } from "@tanstack/react-start";
import { zodValidator } from "@tanstack/zod-adapter";
import {
  closeSecurityFindingInputSchema,
  closedSecurityFindingsInputSchema,
  explainSecurityFindingInputSchema,
  securityFindingIdInputSchema,
} from "../model";
import * as security from "./index";

export const listOpenSecurityFindings = createServerFn({ method: "GET" }).handler(() =>
  security.listOpenSecurityFindings(),
);

export const listClosedSecurityFindings = createServerFn({ method: "GET" })
  .validator(zodValidator(closedSecurityFindingsInputSchema))
  .handler(({ data }) => security.listClosedSecurityFindings(data));

export const closeSecurityFinding = createServerFn({ method: "POST" })
  .validator(zodValidator(closeSecurityFindingInputSchema))
  .handler(({ data }) => security.closeSecurityFinding(data.findingId, data.outcome));

export const reopenSecurityFinding = createServerFn({ method: "POST" })
  .validator(zodValidator(securityFindingIdInputSchema))
  .handler(({ data }) => security.reopenSecurityFinding(data.findingId));

export const explainSecurityFinding = createServerFn({ method: "POST" })
  .validator(zodValidator(explainSecurityFindingInputSchema))
  .handler(({ data }) =>
    security.explainSecurityFinding(data.findingId, data.question, data.earlier),
  );
