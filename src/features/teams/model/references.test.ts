import { expect, test } from "bun:test";
import { decodeReference, encodeReference } from "@/shared/references";
import {
  teamReference,
  teamUri,
  parseTeamUri,
  parseTeamReferenceHash,
  type TeamReferenceTarget,
} from "./references";

test.each([
  [{ type: "team", teamId: "release" }, "team:release"],
  [{ type: "members", teamId: "release" }, "team:release/members"],
  [{ type: "agent", teamId: "release", agentId: "builder" }, "team:release/agents/builder"],
  [{ type: "message", teamId: "release", sequence: 42 }, "team:release/messages/42"],
] satisfies [TeamReferenceTarget, string][])("team references round trip: %s", (target, uri) => {
  expect(teamUri(target)).toBe(uri);
  expect(parseTeamUri(uri)).toEqual(target);
});

test("escaped IDs and Markdown labels preserve identity", () => {
  const target = { type: "agent", teamId: "team/one", agentId: "agent % (one)" } as const;
  const reference = teamReference(target, "Builder [renamed]");
  const decoded = decodeReference(encodeReference(reference))!;
  expect(decoded).toEqual(reference);
  expect(parseTeamUri(`team:${decoded.target}`)).toEqual(target);
});

test.each([
  "team:",
  "team:a/unknown",
  "team:a/members/extra",
  "team:a/agents/",
  "team:a/messages/0",
  "team:a/messages/-1",
  "team:a/messages/1.5",
  "team:a/messages/01",
  "team:a/messages/9007199254740992",
  "team:a?name=other",
  "team:a#42",
  "team:%ZZ",
  "team:%0A",
  "team:%20a",
  "team:a/agents/%00",
  "team:a\n",
  "https://example.com",
])("invalid team URIs stay invalid: %s", (uri) => {
  expect(parseTeamUri(uri)).toBeUndefined();
});

test("URI generation rejects invalid identities and sequences", () => {
  expect(() => teamUri({ type: "team", teamId: "" })).toThrow();
  expect(() => teamUri({ type: "message", teamId: "a", sequence: 0 })).toThrow();
});

test("workspace hashes preserve escaped URI segments without double decoding", () => {
  const target = { type: "agent", teamId: "one/two", agentId: "critic%one" } as const;
  const uri = teamUri(target);
  expect(parseTeamReferenceHash(uri)).toEqual(target);
  expect(parseTeamReferenceHash(encodeURIComponent(uri))).toEqual(target);
  expect(parseTeamReferenceHash("%ZZ")).toBeUndefined();
});
