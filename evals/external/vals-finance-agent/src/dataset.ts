// Reads data/public.csv (Question, Answer, Question Type, Expert time (mins), Rubric).
import fs from "node:fs";
import { DATASET_CSV } from "./config";

export type Operator = "correctness" | "contradiction" | (string & {});

export interface RubricItem {
  operator: Operator;
  criteria: string;
}

export interface BenchQuestion {
  /** q001..q050 in CSV order (run_agent.py numbers questions the same way). */
  id: string;
  index: number;
  question: string;
  answer: string;
  type: string;
  expertMinutes: number | null;
  rubric: RubricItem[];
}

/** RFC 4180 parser: quoted fields may contain commas, quotes ("") and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function loadQuestions(file = DATASET_CSV): BenchQuestion[] {
  const rows = parseCsv(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  const header = rows[0];
  if (!header) throw new Error(`empty CSV: ${file}`);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing column ${name} in ${file}`);
    return i;
  };
  const iq = col("Question");
  const ia = col("Answer");
  const it = col("Question Type");
  const ie = col("Expert time (mins)");
  const ir = col("Rubric");
  return rows.slice(1).map((r, idx) => {
    const rubric = JSON.parse(r[ir] ?? "[]") as RubricItem[];
    const minutes = Number(r[ie]);
    return {
      id: `q${String(idx + 1).padStart(3, "0")}`,
      index: idx + 1,
      question: r[iq] ?? "",
      answer: r[ia] ?? "",
      type: (r[it] ?? "").trim(),
      expertMinutes: Number.isFinite(minutes) ? minutes : null,
      rubric,
    };
  });
}
