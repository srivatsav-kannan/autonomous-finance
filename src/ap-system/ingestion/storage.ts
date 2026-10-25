import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export function inside(root: string, ref: string) {
  const file = resolve(root, ref),
    rel = relative(resolve(root), file);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("artifact_outside_storage");
  return file;
}
export async function saveArtifact(
  root: string,
  bytes: Uint8Array | string,
  suffix = "json",
) {
  const hash = sha256(bytes),
    ref = `artifacts/${hash}.${suffix.replace(/[^a-z0-9]/gi, "")}`;
  const file = inside(root, ref);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (sha256(await readFile(file)) !== hash)
      throw new Error("artifact_integrity_conflict");
  }
  return { ref, sha256: hash };
}
export async function readArtifact(
  root: string,
  artifact: { ref: string; sha256: string },
) {
  const bytes = await readFile(inside(root, artifact.ref));
  if (sha256(bytes) !== artifact.sha256)
    throw new Error("artifact_hash_mismatch");
  return bytes;
}
export async function atomicJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
