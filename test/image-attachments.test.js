import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { readSessionSnapshot, readSessionHistory } from "../session-scanner.js";
import { buildHistoryPage } from "../history-page.js";

const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=" };
const waitFor = (check) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 3000;
  const poll = () => {
    const result = check();
    if (result) return resolve(result);
    if (Date.now() > deadline) return reject(new Error("Timed out waiting for image delivery"));
    setTimeout(poll, 10);
  };
  poll();
});

test("image-only messages survive persisted snapshot reload and paginated history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "toilet-images-"));
  const file = path.join(dir, "session.jsonl");
  const entries = [{ type: "message", id: "entry", parentId: null, message: { role: "user", content: [image], timestamp: 1 } }];
  try {
    await writeFile(file, [{ type: "session", version: 3, id: "session", cwd: dir }, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
    assert.deepEqual((await readSessionSnapshot(file)).history[0].images, [image]);
    assert.deepEqual(buildHistoryPage(entries).messages[0].images, [image]);
    const large = { ...image, data: Buffer.alloc(512 * 1024).toString("base64") };
    const page = buildHistoryPage([{ ...entries[0], message: { role: "user", content: [large, large, large, large] } }]);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].images.length, 4);
    assert.equal(page.hasMore, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("inactive OMP history resolves bounded, hash-verified image blobs from its configured store", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "toilet-image-blobs-"));
  const file = path.join(dir, "session.jsonl");
  const blobDir = path.join(dir, "blobs");
  const bytes = Buffer.from(image.data, "base64");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const entry = { type: "message", id: "entry", parentId: null,
    message: { role: "user", content: [{ ...image, data: `blob:sha256:${hash}` }], timestamp: 1 } };
  try {
    await mkdir(blobDir);
    await writeFile(path.join(blobDir, hash), bytes);
    await writeFile(file, [{ type: "session", version: 3, id: "session", cwd: dir }, entry].map(e => JSON.stringify(e)).join("\n") + "\n");
    const options = { blobDirs: [blobDir] };
    assert.deepEqual((await readSessionSnapshot(file, options)).history[0].images, [image]);
    assert.deepEqual((await readSessionHistory(file, options)).messages[0].images, [image]);
    await writeFile(path.join(blobDir, hash), Buffer.from("not the referenced image"));
    const corrupted = await readSessionHistory(file, options);
    assert.equal(corrupted.messages[0].images, undefined);
    assert.equal(corrupted.complete, false);
    await writeFile(path.join(blobDir, hash), Buffer.alloc(512 * 1024 + 1));
    assert.equal((await readSessionSnapshot(file, options)).history[0].images, undefined);
    await rm(path.join(blobDir, hash));
    assert.equal((await readSessionHistory(file, options)).complete, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("extension dispatches image content to sendUserMessage and mirrors images in live events", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  const previousUrl = process.env.TOILET_PI_SERVER_URL;
  process.env.TOILET_PI_SERVER_URL = `ws://127.0.0.1:${server.address().port}/ws?token=test-token`;
  const received = [], delivered = [], handlers = new Map();
  let socket;
  server.on("connection", client => { socket = client; client.on("message", data => received.push(JSON.parse(String(data)))); });
  const pi = {
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    registerCommand() {},
    sendUserMessage(content, options) { delivered.push({ content, options }); },
  };
  const context = { hasUI: false, model: null, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "image-session", getSessionFile: () => null, getSessionName: () => null,
      getCwd: () => process.cwd(), getBranch: () => [] } };
  try {
    const { default: register } = await import(`../toilet-pi.ts?image-test=${Date.now()}`);
    register(pi);
    await handlers.get("session_start")[0]({}, context);
    const hello = await waitFor(() => received.find(message => message.type === "hello"));
    assert(hello.capabilities.includes("image_input_v1"));
    socket.send(JSON.stringify({ type: "input", text: "", images: [image], inputId: "image-input" }));
    await waitFor(() => delivered.length);
    assert.deepEqual(delivered[0].content, [image]);
    await handlers.get("message_end")[0]({ message: { role: "user", content: delivered[0].content, timestamp: 1 } });
    const event = await waitFor(() => received.find(message => message.event?.type === "message"));
    assert.deepEqual(event.event.message.images, [image]);
    assert.equal(event.event.message.remoteInputId, "image-input");
    pi.sendUserMessage = () => { throw new Error("image provider unavailable"); };
    socket.send(JSON.stringify({ type: "input", text: "", images: [image], inputId: "failed-image" }));
    const failed = await waitFor(() => received.find(message => message.event?.type === "remote_input_failed"));
    assert.equal(failed.event.inputId, "failed-image");
    assert.equal(failed.event.message, "image provider unavailable");
  } finally {
    await handlers.get("session_shutdown")?.[0]({}, context);
    if (previousUrl === undefined) delete process.env.TOILET_PI_SERVER_URL;
    else process.env.TOILET_PI_SERVER_URL = previousUrl;
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});
