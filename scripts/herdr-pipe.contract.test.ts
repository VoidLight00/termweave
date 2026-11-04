import { afterAll, beforeAll, expect, it } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRpc, paneRead } from "../server/herdr/client.ts";

/**
 * The herdr client over a real socket this test serves itself: a named pipe on Windows
 * (`\\.\pipe\…`, where herdr listens there), a unix socket elsewhere. No herdr is reached,
 * so the answers can come cut, unfinished, late or broken on purpose.
 */
const name = `termweave-herdr-pipe-${process.pid}-${Date.now().toString(36)}`;
const address = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
const encoder = new TextEncoder();

/** how the next connection is answered, given the request's id */
let answer: (socket: Socket, id: string) => void | Promise<void> = () => undefined;
const connections = new Set<Socket>();
let server: Server;

beforeAll(async () => {
  server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => undefined);
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8");
      const end = request.indexOf("\n");
      if (end === -1) return;
      const { id } = JSON.parse(request.slice(0, end)) as { id: string };
      request = request.slice(end + 1);
      void answer(socket, id);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => resolve());
  });
});

afterAll(async () => {
  for (const socket of connections) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (process.platform !== "win32") rmSync(address, { force: true });
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** writes the bytes in the given pieces, each after the last has had time to arrive alone */
async function writeCut(socket: Socket, bytes: Uint8Array, cuts: number[]) {
  let from = 0;
  for (const to of [...cuts, bytes.length]) {
    socket.write(bytes.subarray(from, to));
    from = to;
    await pause(20);
  }
}
const failure = async (request: Promise<unknown>): Promise<HerdrError> => {
  const error = await request.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HerdrError);
  return error as HerdrError;
};

const SCREEN = "한글 입력 🎉👍🏽 끝";

it("reads a pane whose answer comes cut inside its characters, the text as herdr sent it", async () => {
  answer = async (socket, id) => {
    const bytes = encoder.encode(`${JSON.stringify({ id, result: { read: { pane_id: "w1-1", text: SCREEN } } })}\n`);
    const start = bytes.length - encoder.encode(`${SCREEN}"}}}\n`).length;
    // after 1 and 2 of 한's 3 bytes, 2 of 🎉's 4, 2 of 👍's 4, and 1 and 2 of 끝's 3
    await writeCut(socket, bytes, [start + 1, start + 2, start + 16, start + 20, bytes.length - 7, bytes.length - 6]);
  };
  const read = await paneRead({ paneId: "w1-1", format: "ansi", timeoutMs: 5000 }, address);
  expect(read.text).toBe(SCREEN);
  expect(read.text).not.toContain("\uFFFD");
});

it("still replaces bytes that are no UTF-8 with U+FFFD, and answers", async () => {
  answer = async (socket, id) => {
    const [head, tail] = `${JSON.stringify({ id, result: { text: "a|b" } })}\n`.split("|") as [string, string];
    const bytes = new Uint8Array([...encoder.encode(head), 0xff, ...encoder.encode(tail)]);
    await writeCut(socket, bytes, [head.length, head.length + 1]);
  };
  expect(await herdrRpc<{ text: string }>("pane.read", {}, address, 5000)).toEqual({ text: "a\uFFFDb" });
});

it("fails as closed when herdr ends the connection inside its answer, a character cut off", async () => {
  answer = async (socket, id) => {
    const bytes = encoder.encode(`${JSON.stringify({ id, result: { read: { text: "한" } } })}\n`);
    // up to the first byte of 한: the JSON and the character are both unfinished
    const cut = bytes.indexOf(0xed) + 1;
    await writeCut(socket, bytes.subarray(0, cut), []);
    socket.end();
  };
  const error = await failure(herdrRpc("pane.read", {}, address, 5000));
  expect(error.code).toBe("closed");
});

it("fails as closed when the answer is whole but its newline never came", async () => {
  answer = (socket, id) => {
    socket.end(JSON.stringify({ id, result: { ok: true } }));
  };
  const error = await failure(herdrRpc("ping", {}, address, 5000));
  expect(error.code).toBe("closed");
});

it("fails as a bad frame when the answer is no JSON", async () => {
  answer = async (socket) => {
    await writeCut(socket, encoder.encode("{not json 한\n"), [3, 12]);
  };
  const error = await failure(herdrRpc("ping", {}, address, 5000));
  expect(error.code).toBe("bad_frame");
});

it("fails with herdr's own code when it answers with an error", async () => {
  answer = (socket, id) => {
    socket.write(`${JSON.stringify({ id, error: { code: "pane_not_found", message: "no pane" } })}\n`);
  };
  const error = await failure(herdrRpc("pane.read", {}, address, 5000));
  expect(error.code).toBe("pane_not_found");
});

it("times out when herdr takes the request and never answers", async () => {
  answer = () => undefined;
  const started = Date.now();
  const error = await failure(herdrRpc("ping", {}, address, 300));
  expect(error.code).toBe("timeout");
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
});
