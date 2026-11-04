import type { Reference } from "@/shared/references";

export type ChannelReferenceTarget = { channelId: string } & (
  | { type: "channel" }
  | { type: "team" }
  | { type: "agent"; agentId: string }
  | { type: "message"; sequence: number }
);

function validId(id: string): boolean {
  return id.length > 0 && id.length <= 255 && id === id.trim() && !/\p{Cc}/u.test(id);
}

function encodeId(id: string): string {
  if (!validId(id)) throw new Error("Invalid channel reference ID.");
  return encodeURIComponent(id).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function channelUri(target: ChannelReferenceTarget): string {
  const uri = `channel:${encodeId(target.channelId)}`;
  switch (target.type) {
    case "channel":
      return uri;
    case "team":
      return `${uri}/team`;
    case "agent":
      return `${uri}/agents/${encodeId(target.agentId)}`;
    case "message":
      if (!Number.isSafeInteger(target.sequence) || target.sequence <= 0)
        throw new Error("Invalid channel message sequence.");
      return `${uri}/messages/${target.sequence}`;
  }
}

export function parseChannelUri(uri: string): ChannelReferenceTarget | undefined {
  const match =
    /^channel:([^/?#\s]+)(?:\/(team)|\/agents\/([^/?#\s]+)|\/messages\/([1-9]\d*))?$/.exec(uri);
  if (!match || match[0] !== uri) return;
  let channelId: string;
  let agentId: string | undefined;
  try {
    channelId = decodeURIComponent(match[1]!);
    agentId = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
  } catch {
    return;
  }
  if (!validId(channelId) || (agentId !== undefined && !validId(agentId))) return;
  if (match[2]) return { type: "team", channelId };
  if (agentId !== undefined) return { type: "agent", channelId, agentId };
  if (match[4]) {
    const sequence = Number(match[4]);
    return Number.isSafeInteger(sequence) ? { type: "message", channelId, sequence } : undefined;
  }
  return { type: "channel", channelId };
}

export function channelReference(target: ChannelReferenceTarget, label: string): Reference {
  return { kind: "channel", target: channelUri(target).slice("channel:".length), label };
}

export function parseChannelReferenceHash(hash: string): ChannelReferenceTarget | undefined {
  const direct = parseChannelUri(hash);
  if (direct) return direct;
  try {
    return parseChannelUri(decodeURIComponent(hash));
  } catch {
    return;
  }
}
