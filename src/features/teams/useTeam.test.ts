import { describe, expect, test } from "bun:test";
import type { Team } from "./model";
import { nextTeamVisit, type TeamVisit } from "./useTeam";

const team = { seenThrough: 4, latestSequence: 7 } as Team;
const away: TeamVisit = { status: "away" };

describe("team visits", () => {
  test("a visit that joins an open observer reads the unread position at once", () => {
    expect(nextTeamVisit(away, { reading: true, joined: team })).toEqual({
      status: "reading",
      unreadAfter: 4,
    });
  });

  test("otherwise a visit awaits an arrival newer than the one it began with", () => {
    const arriving = nextTeamVisit(away, {
      reading: true,
      arrival: { id: 1, unreadAfter: 2 },
    });
    expect(arriving).toEqual({ status: "arriving", afterArrival: 1 });
    expect(nextTeamVisit(arriving, { reading: true, arrival: { id: 1, unreadAfter: 2 } })).toBe(
      arriving,
    );
    expect(nextTeamVisit(arriving, { reading: true, arrival: { id: 2, unreadAfter: 5 } })).toEqual({
      status: "reading",
      unreadAfter: 5,
    });
  });

  test("arrivals during a visit never move its unread position", () => {
    const reading: TeamVisit = { status: "reading", unreadAfter: 4 };
    expect(
      nextTeamVisit(reading, {
        reading: true,
        joined: team,
        arrival: { id: 9, unreadAfter: 8 },
      }),
    ).toBe(reading);
  });

  test("leaving ends the visit, and staying away changes nothing", () => {
    expect(nextTeamVisit({ status: "reading", unreadAfter: 4 }, { reading: false })).toEqual(away);
    expect(nextTeamVisit(away, { reading: false, joined: team })).toBe(away);
  });
});
