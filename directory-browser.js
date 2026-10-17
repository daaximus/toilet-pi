import { access, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DIRECTORY_ENTRY_LIMIT = 500;

// Lists filesystem roots: drive letters on Windows, "/" elsewhere.
async function listRoots() {
  if (process.platform !== "win32") return ["/"];
  const roots = [];
  await Promise.all(
    Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).map(async (drive) => {
      try {
        await access(drive);
        roots.push(drive);
      } catch {
        // Drive letter not mounted.
      }
    }),
  );
  return roots.sort();
}

function isHiddenName(name) {
  return name.startsWith(".") || name.startsWith("$");
}

/**
 * Lists the subdirectories of `target` (absolute path; null = home directory).
 * Hidden entries (dot/`$` prefixed) are omitted. Returns a listing usable as a
 * working-directory picker; errors are reported via a thrown Error.
 */
export async function listDirectory(target) {
  const resolved = path.resolve(target || homedir());
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  const dirents = await readdir(resolved, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || isHiddenName(dirent.name)) continue;
    entries.push({ name: dirent.name, path: path.join(resolved, dirent.name) });
    if (entries.length >= DIRECTORY_ENTRY_LIMIT) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    roots: await listRoots(),
    entries,
  };
}

/** Creates `target` (and missing parents) and returns its listing. */
export async function createDirectory(target) {
  const resolved = path.resolve(target);
  const base = path.basename(resolved);
  if (!base || base === "." || base === "..") throw new Error("Invalid directory name");
  await mkdir(resolved, { recursive: true });
  return listDirectory(resolved);
}
