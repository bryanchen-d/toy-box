import { describe, expect, test } from "bun:test";
import type { Channel } from "./model";
import { nextChannelVisit, type ChannelVisit } from "./useChannel";

const channel = { seenThrough: 4, latestSequence: 7 } as Channel;
const away: ChannelVisit = { status: "away" };

describe("channel visits", () => {
  test("a visit that joins an open observer reads the unread position at once", () => {
    expect(nextChannelVisit(away, { reading: true, joined: channel })).toEqual({
      status: "reading",
      unreadAfter: 4,
    });
  });

  test("otherwise a visit awaits an arrival newer than the one it began with", () => {
    const arriving = nextChannelVisit(away, {
      reading: true,
      arrival: { id: 1, unreadAfter: 2 },
    });
    expect(arriving).toEqual({ status: "arriving", afterArrival: 1 });
    expect(nextChannelVisit(arriving, { reading: true, arrival: { id: 1, unreadAfter: 2 } })).toBe(
      arriving,
    );
    expect(
      nextChannelVisit(arriving, { reading: true, arrival: { id: 2, unreadAfter: 5 } }),
    ).toEqual({ status: "reading", unreadAfter: 5 });
  });

  test("arrivals during a visit never move its unread position", () => {
    const reading: ChannelVisit = { status: "reading", unreadAfter: 4 };
    expect(
      nextChannelVisit(reading, {
        reading: true,
        joined: channel,
        arrival: { id: 9, unreadAfter: 8 },
      }),
    ).toBe(reading);
  });

  test("leaving ends the visit, and staying away changes nothing", () => {
    expect(nextChannelVisit({ status: "reading", unreadAfter: 4 }, { reading: false })).toEqual(
      away,
    );
    expect(nextChannelVisit(away, { reading: false, joined: channel })).toBe(away);
  });
});
