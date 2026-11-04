import { expect, test } from "bun:test";
import { decodeReference, encodeReference } from "@/shared/references";
import {
  channelReference,
  channelUri,
  parseChannelUri,
  parseChannelReferenceHash,
  type ChannelReferenceTarget,
} from "./references";

test.each([
  [{ type: "channel", channelId: "release" }, "channel:release"],
  [{ type: "team", channelId: "release" }, "channel:release/team"],
  [{ type: "agent", channelId: "release", agentId: "builder" }, "channel:release/agents/builder"],
  [{ type: "message", channelId: "release", sequence: 42 }, "channel:release/messages/42"],
] satisfies [ChannelReferenceTarget, string][])(
  "channel references round trip: %s",
  (target, uri) => {
    expect(channelUri(target)).toBe(uri);
    expect(parseChannelUri(uri)).toEqual(target);
  },
);

test("escaped IDs and Markdown labels preserve identity", () => {
  const target = { type: "agent", channelId: "team/one", agentId: "agent % (one)" } as const;
  const reference = channelReference(target, "Builder [renamed]");
  const decoded = decodeReference(encodeReference(reference))!;
  expect(decoded).toEqual(reference);
  expect(parseChannelUri(`channel:${decoded.target}`)).toEqual(target);
});

test.each([
  "channel:",
  "channel:a/unknown",
  "channel:a/team/extra",
  "channel:a/agents/",
  "channel:a/messages/0",
  "channel:a/messages/-1",
  "channel:a/messages/1.5",
  "channel:a/messages/01",
  "channel:a/messages/9007199254740992",
  "channel:a?name=other",
  "channel:a#42",
  "channel:%ZZ",
  "channel:%0A",
  "channel:%20a",
  "channel:a/agents/%00",
  "channel:a\n",
  "https://example.com",
])("invalid channel URIs stay invalid: %s", (uri) => {
  expect(parseChannelUri(uri)).toBeUndefined();
});

test("URI generation rejects invalid identities and sequences", () => {
  expect(() => channelUri({ type: "channel", channelId: "" })).toThrow();
  expect(() => channelUri({ type: "message", channelId: "a", sequence: 0 })).toThrow();
});

test("workspace hashes preserve escaped URI segments without double decoding", () => {
  const target = { type: "agent", channelId: "one/two", agentId: "critic%one" } as const;
  const uri = channelUri(target);
  expect(parseChannelReferenceHash(uri)).toEqual(target);
  expect(parseChannelReferenceHash(encodeURIComponent(uri))).toEqual(target);
  expect(parseChannelReferenceHash("%ZZ")).toBeUndefined();
});
