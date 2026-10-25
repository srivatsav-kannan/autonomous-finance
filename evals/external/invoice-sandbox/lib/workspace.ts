// Read-only view of one run workspace (runs/<id>/workspace). PDFs are served as the pypdf text
// extracted into runs/<id>/text_cache by extract_text.py. Paths are confined to the workspace,
// so nothing outside it (answer_key, scripts, other runs) is reachable.
import fs from "node:fs";
import path from "node:path";

export interface DirEntry {
  name: string;
  type: "file" | "dir";
  size_bytes?: number;
  entries?: number;
}

export class Workspace {
  readonly root: string;
  constructor(
    root: string,
    readonly textCache: string,
  ) {
    this.root = fs.realpathSync(root);
  }

  /** Normalizes a model-supplied path ("./a/b", "/a/b", "a/b") and rejects anything that escapes the root. */
  resolve(rel: string): { abs: string; rel: string } {
    const cleaned = rel.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
    const abs = path.resolve(this.root, cleaned === "" ? "." : cleaned);
    const back = path.relative(this.root, abs);
    if (back === ".." || back.startsWith(".." + path.sep) || path.isAbsolute(back)) throw new Error(`path outside workspace: ${rel}`);
    if (fs.existsSync(abs)) {
      const real = fs.realpathSync(abs);
      const realBack = path.relative(this.root, real);
      if (realBack.startsWith("..") || path.isAbsolute(realBack)) throw new Error(`path outside workspace: ${rel}`);
    }
    return { abs, rel: back.split(path.sep).join("/") };
  }

  listDir(rel: string): DirEntry[] {
    const { abs } = this.resolve(rel);
    if (!fs.existsSync(abs)) throw new Error(`no such directory: ${rel}`);
    if (!fs.statSync(abs).isDirectory()) throw new Error(`not a directory: ${rel}`);
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => {
        const p = path.join(abs, d.name);
        return d.isDirectory()
          ? { name: d.name, type: "dir" as const, entries: fs.readdirSync(p).length }
          : { name: d.name, type: "file" as const, size_bytes: fs.statSync(p).size };
      });
  }

  /** Full text of a file: extracted text for PDFs, UTF-8 contents otherwise. */
  readText(rel: string): string {
    const { abs, rel: norm } = this.resolve(rel);
    if (!fs.existsSync(abs)) throw new Error(`no such file: ${rel}`);
    if (fs.statSync(abs).isDirectory()) throw new Error(`is a directory: ${rel}`);
    if (norm.toLowerCase().endsWith(".pdf")) {
      const cached = path.join(this.textCache, `${norm}.txt`);
      if (!fs.existsSync(cached)) throw new Error(`no extracted text for ${norm} (run extract_text.py)`);
      return fs.readFileSync(cached, "utf8");
    }
    return fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
  }

  /** Every file under the workspace, workspace-relative, sorted. */
  allFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else out.push(path.relative(this.root, p).split(path.sep).join("/"));
      }
    };
    walk(this.root);
    return out.sort();
  }
}
