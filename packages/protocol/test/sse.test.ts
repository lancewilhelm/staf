import { expect, test } from "bun:test";
import { SseParser } from "../src/client.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

test("SseParser joins events that arrive in pieces and skips comments", () => {
  const parser = new SseParser();
  expect(parser.push(bytes('data: {"a":'))).toEqual([]);
  expect(parser.push(bytes("1}\n\n: ping\n\ndata: 2\r\n\r\n"))).toEqual(['{"a":1}', "2"]);
});

test("SseParser keeps multi-byte characters that are split across chunks", () => {
  const parser = new SseParser();
  const encoded = bytes('data: "é"\n\n');
  expect(parser.push(encoded.slice(0, 8))).toEqual([]);
  expect(parser.push(encoded.slice(8))).toEqual(['"é"']);
});
