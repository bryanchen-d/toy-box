import type { Reference } from "@/shared/references";

export type TeamReferenceTarget = { teamId: string } & (
  | { type: "team" }
  | { type: "members" }
  | { type: "agent"; agentId: string }
  | { type: "message"; sequence: number }
);

function validId(id: string): boolean {
  return id.length > 0 && id.length <= 255 && id === id.trim() && !/\p{Cc}/u.test(id);
}

function encodeId(id: string): string {
  if (!validId(id)) throw new Error("Invalid team reference ID.");
  return encodeURIComponent(id).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function teamUri(target: TeamReferenceTarget): string {
  const uri = `team:${encodeId(target.teamId)}`;
  switch (target.type) {
    case "team":
      return uri;
    case "members":
      return `${uri}/members`;
    case "agent":
      return `${uri}/agents/${encodeId(target.agentId)}`;
    case "message":
      if (!Number.isSafeInteger(target.sequence) || target.sequence <= 0)
        throw new Error("Invalid team message sequence.");
      return `${uri}/messages/${target.sequence}`;
  }
}

export function parseTeamUri(uri: string): TeamReferenceTarget | undefined {
  const match =
    /^team:([^/?#\s]+)(?:\/(members)|\/agents\/([^/?#\s]+)|\/messages\/([1-9]\d*))?$/.exec(uri);
  if (!match || match[0] !== uri) return;
  let teamId: string;
  let agentId: string | undefined;
  try {
    teamId = decodeURIComponent(match[1]!);
    agentId = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
  } catch {
    return;
  }
  if (!validId(teamId) || (agentId !== undefined && !validId(agentId))) return;
  if (match[2]) return { type: "members", teamId };
  if (agentId !== undefined) return { type: "agent", teamId, agentId };
  if (match[4]) {
    const sequence = Number(match[4]);
    return Number.isSafeInteger(sequence) ? { type: "message", teamId, sequence } : undefined;
  }
  return { type: "team", teamId };
}

export function teamReference(target: TeamReferenceTarget, label: string): Reference {
  return { kind: "team", target: teamUri(target).slice("team:".length), label };
}

export function parseTeamReferenceHash(hash: string): TeamReferenceTarget | undefined {
  const direct = parseTeamUri(hash);
  if (direct) return direct;
  try {
    return parseTeamUri(decodeURIComponent(hash));
  } catch {
    return;
  }
}
