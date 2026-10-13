import { describe, expect, test } from "bun:test";
import { decodeScreenPacket, ScreenPacketReader, screenClientMessageSchema } from "./protocol";

/** The helper writes packets natively; tests build them the same way. */
function encode(metadata: unknown, payload = new Uint8Array()): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const packet = new Uint8Array(8 + json.length + payload.length);
  const header = new DataView(packet.buffer);
  header.setUint32(0, json.length);
  header.setUint32(4, payload.length);
  packet.set(json, 8);
  packet.set(payload, 8 + json.length);
  return packet;
}

describe("screen packets", () => {
  test("decode JSON metadata and a binary payload without copying the payload", () => {
    const payload = new Uint8Array([0, 10, 255, 128]);
    const packet = encode({ sequence: 1 }, payload);
    const decoded = decodeScreenPacket(packet);
    expect(decoded.metadata).toEqual({ sequence: 1 });
    expect(decoded.payload).toEqual(payload);
    expect(decoded.bytes).toBe(packet);
  });

  test("read from a stream split anywhere in the header, metadata or payload", () => {
    const packet = encode({ value: "hello" }, new Uint8Array([1, 2, 3]));
    for (let split = 0; split <= packet.length; split++) {
      const reader = new ScreenPacketReader();
      const packets = [
        ...reader.push(packet.subarray(0, split)),
        ...reader.push(packet.subarray(split)),
      ];
      expect(packets).toHaveLength(1);
      expect(packets[0]!.metadata).toEqual({ value: "hello" });
      expect(packets[0]!.payload).toEqual(new Uint8Array([1, 2, 3]));
      reader.end();
    }
  });

  test("read several packets from one chunk, or one packet from single bytes", () => {
    const first = encode({ a: 1 });
    const second = encode({ b: 2 });
    const both = new Uint8Array([...first, ...second]);
    expect(new ScreenPacketReader().push(both).map((packet) => packet.metadata)).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    const reader = new ScreenPacketReader();
    const bytewise = [...both].flatMap((byte) => reader.push(new Uint8Array([byte])));
    expect(bytewise.map((packet) => packet.metadata)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("reject truncated packets, invalid JSON and streams that end mid-packet", () => {
    const packet = encode({ value: 1 });
    expect(() => decodeScreenPacket(packet.subarray(0, packet.length - 1))).toThrow("length");
    const invalidJson = packet.slice();
    invalidJson[8] = 0;
    expect(() => decodeScreenPacket(invalidJson)).toThrow();
    const reader = new ScreenPacketReader();
    reader.push(packet.subarray(0, 8));
    expect(() => reader.end()).toThrow("mid-packet");
  });
});

test("viewer input must land on the frame and stay within a bounded batch", () => {
  const input = {
    type: "input",
    actions: [{ type: "pointer", x: 0.5, y: 0.5, phase: "down", button: 0 }],
  };
  expect(screenClientMessageSchema.safeParse(input).success).toBe(true);
  expect(
    screenClientMessageSchema.safeParse({ ...input, actions: [{ ...input.actions[0], x: 2 }] })
      .success,
  ).toBe(false);
  expect(
    screenClientMessageSchema.safeParse({ ...input, actions: Array(65).fill(input.actions[0]) })
      .success,
  ).toBe(false);
});
