import { createReadStream } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { buildHistoryPage, selectPersistedBranch } from "./history-page.js";
import { getMessageImages, IMAGE_MIME_TYPES, MAX_IMAGES, MAX_IMAGE_BYTES } from "./server/public/image-attachments.js";

const DEFAULT_MESSAGE_LIMIT = Number.parseInt(
  process.env.TOILET_PI_MESSAGE_LIMIT || "4000",
  10,
);
const DEFAULT_HISTORY_BYTES = Math.max(
  1024,
  Number.parseInt(process.env.TOILET_PI_HISTORY_BYTES || "", 10) || 4 * 1024 * 1024,
);

const summaryCache = new Map();

export function getDefaultSessionDir() {
  return (
    process.env.TOILET_PI_SESSION_DIR ||
    path.join(homedir(), ".pi", "agent", "sessions")
  );
}

// TOILET_PI_SCAN_LIMIT: only the N most recently modified session files are
// summarized per scan (0 or unset = all).
export const SCAN_LIMIT = Math.max(0, Number.parseInt(process.env.TOILET_PI_SCAN_LIMIT || "0", 10) || 0);

export async function scanSessions(sessionDir = getDefaultSessionDir()) {
  const resolvedSessionDir = path.resolve(sessionDir);
  try {
    await access(sessionDir);
  } catch {
    pruneCaches(resolvedSessionDir, new Set());
    return [];
  }

  const files = [];
  await collectJsonlFiles(sessionDir, files);

  // Stat up front so candidates can be ordered newest-first; with a scan limit
  // only the most recently written files are parsed.
  const candidates = [];
  for (const file of files) {
    try {
      candidates.push({ file, info: await stat(file) });
    } catch (error) {
      if (error?.code === "ENOENT") {
        summaryCache.delete(path.resolve(file));
        continue;
      }
      throw error;
    }
  }
  candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);

  const sessions = [];
  const seenFiles = new Set();
  for (const { file, info } of candidates) {
    if (SCAN_LIMIT > 0 && sessions.length >= SCAN_LIMIT) break;
    const cacheKey = path.resolve(file);
    seenFiles.add(cacheKey);

    const fingerprint = getFileFingerprint(info);
    const cached = summaryCache.get(cacheKey);
    let summary;
    if (cached && hasSameFingerprint(cached.fingerprint, fingerprint)) {
      summary = cached.summary;
    } else {
      summary = await summarizeSessionFile(file, info);
      summaryCache.set(cacheKey, { fingerprint, summary });
    }
    if (summary) sessions.push(cloneSummary(summary));
  }

  pruneCaches(resolvedSessionDir, seenFiles);
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

export async function findSessionFile(
  sessionGuid,
  sessionDir = getDefaultSessionDir(),
) {
  if (!sessionGuid) return null;
  const sessions = await scanSessions(sessionDir);
  return (
    sessions.find((session) => session.sessionGuid === sessionGuid)
      ?.sessionFile || null
  );
}

export async function readSessionSnapshot(sessionFile, options = {}) {
  const resolvedFile =
    typeof sessionFile === "string" && sessionFile.trim() ? sessionFile : null;
  if (!resolvedFile) return null;

  const parsed = await readSessionBranch(resolvedFile);
  if (!parsed) return null;
  const { header, entries, updatedAt } = parsed;
  await hydrateImageBlobs(entries, options.blobDirs || [], Number(options.maxHistoryBytes) || DEFAULT_HISTORY_BYTES);
  const history = entries.filter(e => e.type === "message").map(e => {
    const message = sanitizeMessage(e.message, e.timestamp);
    return message && { ...message, ...(e.id ? { entryId: e.id } : {}) };
  }).filter(Boolean);
  return {
    sessionGuid: header.id, sessionFile: resolvedFile, cwd: header.cwd || null,
    sessionName: [...parsed.allEntries].reverse().find(e => e.type === "session_info")?.name || null,
    model: [...entries].reverse().find(e => e.type === "model_change")?.modelId || null,
    history: limitHistoryByBytes(history, Math.max(1024, Number(options.maxHistoryBytes) || DEFAULT_HISTORY_BYTES)),
    updatedAt,
  };
}

export async function readSessionBranch(file) {
  const before = await stat(file);
  if (before.size > 64 * 1024 * 1024) throw Object.assign(new Error("Session exceeds the 64 MiB history read limit"), { code: "too_large" });
  if (!before.size) return null;
  const stream = createReadStream(file, { encoding: "utf8", end: before.size - 1 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header;
  let updatedAt = 0;
  let complete = true;
  const entries = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { complete = false; continue; }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) { complete = false; continue; }
      updatedAt = Math.max(updatedAt, normalizeTimestamp(entry.timestamp), normalizeTimestamp(entry.message?.timestamp));
      if (!header && entry.type === "session") header = entry;
      else entries.push(entry);
      if (entries.length > 200000) throw Object.assign(new Error("Session exceeds the history entry limit"), { code: "too_large" });
    }
  } finally { rl.close(); stream.destroy(); }
  if (!header?.id) return null;
  const after = await stat(file);
  const branch = selectPersistedBranch(entries, header.version >= 2 || entries.some(e => e.id));
  return { ...branch, complete: complete && branch.complete && before.size === after.size && before.mtimeMs === after.mtimeMs,
    allEntries: entries, header, updatedAt: updatedAt || after.mtimeMs };
}

export async function readSessionHistory(file, options = {}) {
  const branch = await readSessionBranch(file);
  if (!branch || (options.sessionGuid && options.sessionGuid !== branch.header.id)) throw new Error("Session file identity mismatch");
  const pageOptions = { ...options, source: "persisted-branch", complete: branch.complete, leafId: branch.leafId };
  const page = buildHistoryPage(branch.entries, pageOptions);
  const ids = new Set(page.messages.map(message => message.entryId).filter(Boolean));
  const complete = await hydrateImageBlobs(branch.entries.filter(entry => ids.has(entry.id)), options.blobDirs || [], 4 * 1024 * 1024);
  return buildHistoryPage(branch.entries, { ...pageOptions, complete: branch.complete && complete });
}

async function hydrateImageBlobs(entries, blobDirs, budget) {
  let complete = true;
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]?.message;
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    let imageCount = 0;
    for (const block of message.content) {
      if (block?.type !== "image" || ++imageCount > MAX_IMAGES) continue;
      const hash = typeof block.data === "string" && /^blob:sha256:([a-f0-9]{64})$/.exec(block.data)?.[1];
      if (!hash || !IMAGE_MIME_TYPES.includes(block.mimeType)) continue;
      let resolved = false;
      for (const directory of blobDirs) {
        if (budget <= 0) break;
        let file;
        try {
          file = await open(path.join(directory, hash), "r");
          const info = await file.stat();
          if (!info.isFile() || !info.size || info.size > MAX_IMAGE_BYTES || info.size > budget) continue;
          const bytes = Buffer.alloc(info.size + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead !== info.size) continue;
          const data = bytes.subarray(0, bytesRead);
          if (createHash("sha256").update(data).digest("hex") !== hash) continue;
          const raster = block.mimeType === "image/png" ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : block.mimeType === "image/jpeg" ? data[0] === 255 && data[1] === 216 && data[2] === 255
            : block.mimeType === "image/gif" ? /^GIF8[79]a$/.test(data.toString("ascii", 0, 6))
            : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
          if (!raster) continue;
          block.data = data.toString("base64");
          budget -= bytesRead;
          resolved = true;
          break;
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) throw error;
        } finally { await file?.close(); }
      }
      if (!resolved) complete = false;
    }
  }
  return complete;
}

async function collectJsonlFiles(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  // OMP stores a session as `<name>.jsonl` plus a sibling `<name>/` directory
  // holding advisor and subagent transcripts (`__advisor.jsonl`, `<Agent>.jsonl`).
  // Those carry their own session headers but are not resumable sessions, so a
  // directory shadowed by a same-named session file is not descended into.
  const sessionNames = new Set();
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      sessionNames.add(entry.name.slice(0, -".jsonl".length));
    }
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (sessionNames.has(entry.name)) continue;
      await collectJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

async function summarizeSessionFile(sessionFile, info) {
  let header = null;
  let sessionName = null;
  let firstUserText = null;
  let updatedAt = 0;

  const stream = createReadStream(sessionFile, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      updatedAt = Math.max(
        updatedAt,
        normalizeTimestamp(entry.timestamp),
        normalizeTimestamp(entry.message?.timestamp),
      );

      if (!header && entry.type === "session") {
        header = entry;
        continue;
      }

      if (
        !firstUserText &&
        entry.type === "message" &&
        entry.message?.role === "user"
      ) {
        firstUserText = extractPreview(entry.message);
      }

      if (
        entry.type === "session_info" &&
        typeof entry.name === "string" &&
        entry.name.trim()
      ) {
        sessionName = entry.name.trim();
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!header?.id) return null;

  return {
    sessionGuid: header.id,
    sessionFile,
    cwd: header.cwd || null,
    sessionName,
    preview: firstUserText,
    updatedAt: updatedAt || info.mtimeMs,
  };
}

function getFileFingerprint(info) {
  return {
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    dev: info.dev,
    ino: info.ino,
  };
}

function hasSameFingerprint(left, right) {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function cloneSummary(summary) {
  return summary ? { ...summary } : null;
}

function pruneCaches(sessionDir, seenFiles) {
  for (const cacheKey of summaryCache.keys()) {
    if (isWithinDirectory(sessionDir, cacheKey) && !seenFiles.has(cacheKey)) {
      summaryCache.delete(cacheKey);
    }
  }
}

function isWithinDirectory(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function sanitizeMessage(message, fallbackTimestamp) {
  if (!message || typeof message !== "object") return null;

  if (message.role === "user") {
    const text = extractUserText(message.content);
    const images = getMessageImages(message.content);
    if (!text && !images?.length) return null;
    return {
      role: "user",
      timestamp: normalizeTimestamp(message.timestamp || fallbackTimestamp),
      text,
      ...(images ? { images } : {}),
    };
  }

  if (message.role === "assistant") {
    const text = extractAssistantText(message.content);
    const thinkingText = extractAssistantThinkingText(message.content);
    if (!text && !thinkingText && message.stopReason === "toolUse") return null;
    return {
      role: "assistant",
      timestamp: normalizeTimestamp(message.timestamp || fallbackTimestamp),
      text: text || (message.stopReason === "toolUse" ? "" : `[${message.stopReason || "done"}]`),
      thinkingText: thinkingText || undefined,
      stopReason: message.stopReason,
    };
  }

  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      timestamp: normalizeTimestamp(message.timestamp || fallbackTimestamp),
      toolCallId: message.toolCallId,
      toolName: message.toolName || "tool",
      text: extractToolResultText(message.content),
      isError: !!message.isError,
    };
  }

  return null;
}

function extractPreview(message) {
  if (typeof message.content === "string") {
    return compactText(message.content);
  }

  if (!Array.isArray(message.content)) return null;

  const text = message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "image") return "[image]";
      return "";
    })
    .join(" ");

  return compactText(text);
}

function extractUserText(content) {
  if (typeof content === "string") return normalizeText(content);
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content.map(extractContentPart).filter(Boolean).join(""),
  );
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content
      .filter((part) => part?.type === "text")
      .map((part) => part.text || "")
      .join(""),
  );
}

function extractAssistantThinkingText(content) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content
      .filter((part) => part?.type === "thinking")
      .map((part) => part.thinking || "")
      .join("\n\n"),
  );
}

function extractToolResultText(content) {
  if (!Array.isArray(content)) return "";
  return normalizeText(
    content.map(extractContentPart).filter(Boolean).join(""),
  );
}

function extractContentPart(part) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "text") return part.text || "";
  if (part.type === "image") return "\n[image]\n";
  return "";
}

function normalizeText(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) return "";
  return truncateText(normalized);
}

function truncateText(text) {
  return text.length > DEFAULT_MESSAGE_LIMIT
    ? `${text.slice(0, DEFAULT_MESSAGE_LIMIT - 1)}…`
    : text;
}

function limitHistoryByBytes(history, maxBytes) {
  let bytes = 0;
  let start = history.length;
  while (start > 0) {
    let entryBytes = 0;
    try {
      entryBytes = Buffer.byteLength(JSON.stringify(history[start - 1]), "utf8");
    } catch {
      start -= 1;
      continue;
    }
    if (bytes + entryBytes > maxBytes) break;
    bytes += entryBytes;
    start -= 1;
  }
  return history.slice(start);
}

function compactText(text) {
  const trimmed = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!trimmed) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}
