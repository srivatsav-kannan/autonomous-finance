import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { canonicalJson } from "../../integrations/contracts";
export const canonical = canonicalJson;
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export class QboError extends Error {
  constructor(
    readonly code: string,
    readonly unknown = false,
  ) {
    super(code);
    this.name = "QboError";
  }
}
/** Only allowlisted error codes leave this module; provider bodies/URLs/headers never logged. */
export const safeError = (e: unknown) =>
  e instanceof QboError ? e.code : "internal_error";
export class PrivateStore {
  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new QboError("private_path_required");
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const s = await lstat(this.root);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.mode & 0o077 ||
      s.uid !== process.getuid?.()
    )
      throw new QboError("unsafe_private_directory");
  }
  path(name: string) {
    if (!/^[a-zA-Z0-9._-]{1,180}$/.test(name))
      throw new QboError("invalid_store_key");
    return join(this.root, name);
  }
  async read<T>(name: string): Promise<T | null> {
    await this.init();
    let f;
    try {
      f = await open(
        this.path(name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new QboError("private_read_failed");
    }
    try {
      const s = await f.stat();
      if (
        !s.isFile() ||
        s.mode & 0o077 ||
        s.uid !== process.getuid?.() ||
        s.size > 4 * 1024 * 1024
      )
        throw new QboError("unsafe_private_file");
      return JSON.parse(await f.readFile("utf8")) as T;
    } finally {
      await f.close();
    }
  }
  async write(name: string, value: unknown) {
    await this.init();
    const temp = this.path(`tmp-${randomBytes(16).toString("hex")}`);
    const f = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await f.writeFile(canonical(value) + "\n");
      await f.sync();
    } finally {
      await f.close();
    }
    try {
      await rename(temp, this.path(name));
      const d = await open(this.root, constants.O_RDONLY);
      try {
        await d.sync();
      } finally {
        await d.close();
      }
    } catch {
      await unlink(temp).catch(() => {});
      throw new QboError("private_write_failed");
    }
  }
  async lock<T>(key: string, run: () => Promise<T>): Promise<T> {
    await this.init();
    const p = this.path(`lock-${key}`);
    const end = Date.now() + 5000;
    while (true) {
      try {
        await mkdir(p, { mode: 0o700 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST")
          throw new QboError("private_lock_failed");
        if (Date.now() >= end) throw new QboError("private_lock_busy");
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    // Never steal an old lock: after a crash an operator must confirm the process is dead.
    try {
      return await run();
    } finally {
      await rmdir(p);
    }
  }
}
