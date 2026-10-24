// edgar_search client tool. Same name, description, parameters and validation as
// tools.py EDGARSearch, but backed by SEC's free EDGAR full-text search
// (efts.sec.gov/LATEST/search-index) instead of sec-api.io (no key available).
import type Anthropic from "@anthropic-ai/sdk";
import {
  EDGAR_FTS_MIN_DATE,
  MAX_END_DATE,
  SEC_MAX_REQUESTS_PER_SECOND,
  SEC_USER_AGENT,
} from "./config";

export const EDGAR_TOOL: Anthropic.Beta.BetaTool = {
  name: "edgar_search",
  description:
    "Search the EDGAR Database through the SEC API. " +
    "You should provide a search query. You can also optionally provide a start date, an end date, a page number, top N results, a list of form types, and/or a list of CIKs. " +
    "The results are returned as a list of dictionaries, each containing the metadata for a filing. It does not contain the full text of the filing.",
  input_schema: {
    type: "object",
    properties: {
      search_query: {
        type: "string",
        description:
          'The case-insensitive search-term or phrase to search the contents of fillings and their attachments. This can be a single word, phrase, or combination of words and phrases. Supported search features include wildcards (*), Boolean operators (OR, NOT), and exact phrase matching by enclosing phrases in quotation marks ("exact phrase"). By default, all terms are joined by an implicit AND operator.',
      },
      form_types: {
        type: "array",
        description:
          "(optional) Limits search to specific EDGAR form types (e.g., ['8-K', '10-Q']) list of strings. Default: all form types",
        items: { type: "string" },
      },
      ciks: {
        type: "array",
        description:
          '(optional) Filters results to filings from specified CIKs, type list of strings. Leading zeros are optional but may be included. Example: [ "0001811414", "1318605" ]. Default: all CIKs',
        items: { type: "string" },
      },
      start_date: {
        type: "string",
        description: `(optional) Start date for the search range in yyyy-mm-dd format. If the value is a date that is later than ${MAX_END_DATE}, it will be set to ${MAX_END_DATE}.`,
        default: "1900-01-01",
      },
      end_date: {
        type: "string",
        description: `(optional) End date for the search range, in the same format as startDate. If the value is a date that is later than ${MAX_END_DATE}, it will be set to ${MAX_END_DATE}.`,
        default: MAX_END_DATE,
      },
      page: {
        type: "integer",
        description:
          "(optional) Used for pagination. Each page contains up to 100 matching filings. Increase the page number to retrieve the next set of 100 filings. Example: 3 retrieves the third page. Default: 1",
        default: 1,
      },
      top_n_results: {
        type: "integer",
        description:
          "(optional) Return only the first N results out of 100 from the page. If not provided, all 100 results will be returned. E.g. if page is 2, and number_of_results is 10, you will receive results 100 to 110.",
        maximum: 100,
        default: 100,
      },
    },
    required: ["search_query"],
  },
  // Streamed request: inputs arrive unvalidated, so execute() validates them.
  eager_input_streaming: true,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** At most N requests in any rolling one-second window, shared process-wide. */
class SlidingWindowLimiter {
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
  ) {}
  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
        if (this.stamps.length < this.maxPerWindow) {
          this.stamps.push(now);
          return;
        }
        await sleep(this.windowMs - (now - this.stamps[0]!) + 5);
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export const secLimiter = new SlidingWindowLimiter(SEC_MAX_REQUESTS_PER_SECOND, 1000);

/**
 * GET with the SEC-required User-Agent and the shared rate limit. Like the official
 * harness (retry_http_errors(429, 503)), rate limits and server errors are retried
 * with backoff instead of being returned to the agent; network errors and timeouts
 * are retried too. Other statuses (403, 404, ...) are returned to the caller.
 */
export async function secGet(url: string, accept = "application/json"): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    await secLimiter.acquire();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": SEC_USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status !== 429 && res.status < 500) return res;
      lastErr = new Error(`${res.status} ${res.statusText} for ${url}`);
      await res.body?.cancel();
    } catch (err) {
      lastErr = err; // network error or timeout
    }
    await sleep(Math.min(60_000, 2000 * 2 ** attempt) * (0.5 + Math.random()));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface EftsSource {
  ciks?: string[];
  display_names?: string[];
  form?: string;
  root_forms?: string[];
  file_type?: string;
  file_description?: string | null;
  file_date?: string;
  period_ending?: string | null;
  adsh?: string;
}
interface EftsHit {
  _id: string;
  _source: EftsSource;
}
interface EftsResponse {
  hits?: { total?: { value: number }; hits?: EftsHit[] };
}

/** Filing metadata in the sec-api.io full-text-search shape the official tool returns. */
export interface FilingResult {
  accessionNo: string;
  cik: string;
  companyNameLong: string;
  ticker: string | null;
  formType: string;
  type: string;
  description: string | null;
  filedAt: string;
  periodOfReport: string | null;
  filingUrl: string;
}

function toResult(hit: EftsHit): FilingResult {
  const s = hit._source;
  const [adshFromId, filename = ""] = hit._id.split(":");
  const adsh = s.adsh ?? adshFromId ?? "";
  const cik = String(Number(s.ciks?.[0] ?? "0"));
  const name = (s.display_names?.[0] ?? "").replace(/\s+/g, " ").trim();
  const ticker = /\(([A-Z0-9.\-, ]+)\)\s*\(CIK/.exec(name)?.[1] ?? null;
  return {
    accessionNo: adsh,
    cik,
    companyNameLong: name,
    ticker,
    formType: s.form ?? s.root_forms?.[0] ?? "",
    type: s.file_type ?? "",
    description: s.file_description ?? null,
    filedAt: s.file_date ?? "",
    periodOfReport: s.period_ending ?? null,
    filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${filename}`,
  };
}

/**
 * Serialises like Python's json.dumps(obj) defaults, which the official tool uses:
 * ", " and ": " separators and ensure_ascii escapes. The separators matter here:
 * with compact JSON (no whitespace) server-side web_fetch accepted only the LAST
 * URL of an edgar_search result as "in prior context" (0/81 earlier URLs vs 24/24
 * last URLs in harness v1), so most filings found via EDGAR could not be fetched.
 */
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(", ")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${pyJsonDumps(k)}: ${pyJsonDumps(x)}`)
      .join(", ")}}`;
  }
  const out = JSON.stringify(v) ?? "null";
  return typeof v === "string" ? out.replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`) : out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface EdgarArgs {
  search_query: string;
  start_date?: string;
  end_date?: string;
  top_n_results?: number;
  page?: number;
  form_types?: unknown;
  ciks?: unknown;
}

/** Mirrors EDGARSearch._execute_search: same defaults, validation and error text. */
export async function edgarSearch(rawArgs: unknown): Promise<FilingResult[]> {
  if (typeof rawArgs !== "object" || rawArgs === null) throw new Error("Tool input must be a JSON object");
  const args = rawArgs as EdgarArgs;
  const allowed = new Set(["search_query", "start_date", "end_date", "top_n_results", "page", "form_types", "ciks"]);
  for (const k of Object.keys(args)) {
    if (!allowed.has(k)) throw new Error(`_execute_search() got an unexpected keyword argument '${k}'`);
  }
  if (typeof args.search_query !== "string" || !args.search_query.trim()) {
    throw new Error("search_query is required and must be a non-empty string");
  }
  let startDate = args.start_date ?? "1900-01-01";
  let endDate = args.end_date ?? MAX_END_DATE;
  const topN = Number(args.top_n_results ?? 100);
  const page = Number(args.page ?? 1);
  const { form_types: formTypes, ciks } = args;

  if (formTypes !== undefined && formTypes !== null && !Array.isArray(formTypes)) {
    throw new Error(`The parameter form_types must be a list if provided. Was of type ${typeof formTypes}`);
  }
  if (ciks !== undefined && ciks !== null && !Array.isArray(ciks)) {
    throw new Error(`The parameter ciks must be a list if provided. Was of type ${typeof ciks}`);
  }
  if (!DATE_RE.test(startDate)) throw new Error(`start_date '${startDate}' is not in yyyy-mm-dd format`);
  if (!DATE_RE.test(endDate)) throw new Error(`end_date '${endDate}' is not in yyyy-mm-dd format`);
  if (startDate > MAX_END_DATE) startDate = MAX_END_DATE;
  if (endDate > MAX_END_DATE) endDate = MAX_END_DATE;
  if (startDate > endDate) {
    throw new Error(`Parameter start_date '${startDate}' was set to a date that is later than end_date '${endDate}'`);
  }
  if (!Number.isInteger(page) || page < 1) throw new Error(`page must be a positive integer, got ${String(args.page)}`);
  if (!Number.isFinite(topN) || topN < 0) throw new Error(`top_n_results must be a number, got ${String(args.top_n_results)}`);
  // EDGAR full-text search starts in 2001; sec-api.io accepts earlier dates but has no earlier filings either.
  const ftsStart = startDate < EDGAR_FTS_MIN_DATE ? EDGAR_FTS_MIN_DATE : startDate;

  const params = new URLSearchParams({ q: args.search_query, dateRange: "custom", startdt: ftsStart, enddt: endDate });
  if (Array.isArray(formTypes) && formTypes.length) params.set("forms", formTypes.map(String).join(","));
  if (Array.isArray(ciks) && ciks.length) {
    params.set(
      "ciks",
      ciks.map((c) => String(c).replace(/\D/g, "").padStart(10, "0")).join(","),
    );
  }
  if (page > 1) params.set("from", String((page - 1) * 100));

  const res = await secGet(`https://efts.sec.gov/LATEST/search-index?${params.toString()}`);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  const data = (await res.json()) as EftsResponse;
  const hits = data.hits?.hits ?? [];
  return hits.slice(0, Math.trunc(topN)).map(toResult);
}
