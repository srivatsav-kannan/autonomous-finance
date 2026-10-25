import type { ProviderOutput } from './provider';
import { decode, normalize, cellNativeRegions, type NativeRegion } from './grounding';

export type ExtractedTableLine = {
  sku: string; description: string; quantity: string; unit: string;
  unitPriceCents: number; amountCents: number; page: number;
  cells: Map<string, { text: string; hint?: NativeRegion }>;
};
const clean = (value: unknown) => decode(String(value ?? '')).replace(/\*\*/g, '').trim();
export const labelKey = (value: string) => normalize(value).replace(/[^a-z0-9]/g, '');
export function money(value: string): number | null {
  const text = clean(value);
  if (text.length > 64) return null;
  const match = /^(?:USD\s*|\$\s*)?((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = BigInt(match[1]!.replaceAll(',', '')) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}
export function exactLineAmount(quantity: string, price: number, amount: number) {
  if (!/^\d{1,18}(?:\.\d{1,6})?$/.test(quantity)) return false;
  const [whole, fraction = ''] = quantity.split('.');
  return BigInt(whole! + fraction) * BigInt(price) === BigInt(amount) * 10n ** BigInt(fraction.length);
}
export const FIELD_LABELS = {
  extractedSupplierName: ['Supplier'],
  invoiceNumber: ['Document Number', 'Invoice Number', 'Invoice #'],
  invoiceDate: ['Invoice Date'], dueDate: ['Due Date'], terms: ['Terms'], currency: ['Currency'],
  subtotalCents: ['Subtotal'], taxCents: ['Tax'], freightCents: ['Freight'], discountCents: ['Discount'],
  totalCents: ['Invoice Total', 'Grand Total', 'Total'],
  reference: ['Document Number'], delivery: ['Delivery Reference'],
  acceptedBy: ['Receiving owner'], acceptedAt: ['Acceptance recorded'],
} as const;
type HeaderField = keyof typeof FIELD_LABELS;
const fields = Object.keys(FIELD_LABELS) as HeaderField[];
const delimiters = ['Bill To', 'PO Reference', 'Work reference', 'Store', 'Total Due', 'Balance Due'];
const allLabels = [...new Set([...Object.values(FIELD_LABELS).flat(), ...delimiters])].sort((a,b)=>b.length-a.length);
const pattern = (labels: readonly string[]) => labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+')).join('|');
const inlinePattern = new RegExp('(?:^|[\\s|])(' + pattern(allLabels) + ')\\s*:\\s*', 'gi');
const isKnownLabel = (value: string) => allLabels.some(label => labelKey(label) === labelKey(value.replace(/:$/, '')));

/** Read explicit label/value structure. Unlabelled prose is not a monetary assertion. */
export function headerFields(output: ProviderOutput) {
  const values = new Map<HeaderField, string[]>(fields.map(field => [field, []]));
  const add = (label: string, raw: string) => {
    const value = clean(raw);
    if (!value) return;
    for (const field of fields) if (FIELD_LABELS[field].some(alias => labelKey(alias) === labelKey(label))) values.get(field)!.push(value);
  };
  const scanText = (input: string) => {
    const lines = clean(input).split(/\r?\n/);
    for (const [index,line] of lines.entries()) {
      const matches = [...line.matchAll(inlinePattern)];
      for (const [i,match] of matches.entries()) {
        let raw = line.slice(match.index! + match[0].length, matches[i+1]?.index ?? line.length).trim();
        // A standalone label may introduce exactly the next non-label line.
        if (!raw && matches.length === 1 && line.trim().endsWith(':') && lines[index+1] && ![...lines[index+1]!.matchAll(inlinePattern)].length && !isKnownLabel(lines[index+1]!)) raw=lines[index+1]!.trim();
        add(match[1]!,raw);
      }
      if (!matches.length) {
        const match = new RegExp('^\\s*(' + pattern(fields.filter(f=>f.endsWith('Cents')).flatMap(f=>[...FIELD_LABELS[f]])) + ')\\s+(.+)$','i').exec(line);
        if (match && money(match[2]!) !== null) add(match[1]!,match[2]!);
      }
    }
  };
  const scanRow = (row: string[]) => {
    for (const [index,cell] of row.entries()) {
      scanText(cell);
      if (!isKnownLabel(cell)) continue;
      const next = row.slice(index+1).find(value=>value.trim());
      if (next && !isKnownLabel(next) && ![...next.matchAll(inlinePattern)].length) add(cell.replace(/:$/, ''),next);
    }
  };
  let text = String(output.result.markdown_full ?? '');
  text = text.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_table, body: string) => {
    for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => clean(cell[1]!.replace(/<(?!br\b)[^>]+>/gi,'')));
      scanRow(cells);
    }
    return '\n';
  });
  text=clean(text.replace(/<(?!br\b)[^>]+>/gi,''));
  for (const line of text.split(/\r?\n/)) if (line.includes('|')) scanRow(line.split('|').map(clean));
  scanText(text.split(/\r?\n/).filter(line=>!line.includes('|')).join('\n'));
  const result = {} as Record<HeaderField,string|null>;
  const issues: string[] = [];
  for (const field of fields) {
    const candidates=values.get(field)!;
    const keys = candidates.map(value => field.endsWith('Cents') ? (money(value) === null ? 'invalid:'+value : String(money(value))) : value.replace(/\s+/g,' '));
    if (new Set(keys).size>1) issues.push('ambiguous_'+field);
    result[field]=new Set(keys).size===1 ? candidates[0]! : null;
  }
  return {...result,issues,text};
}

const COLUMNS: Record<string,string[]> = {
  sku:['sku','itemcode','item'], description:['description'], quantity:['qty','quantity'],
  unit:['uom','unitofmeasure'], unitPriceCents:['unitusd','unitprice','unitpriceusd','price','rate'],
  amountCents:['amountusd','amount','lineamount','linetotal'],
};
function columnMap(row: unknown[]) {
  const cells=row.map(clean);
  let keys=cells.map(labelKey);
  // Strip only a repeated spanning title shared by every column, never a guessed suffix.
  const parts=cells.map(cell=>cell.split(/\r?\n/).map(s=>s.trim()).filter(Boolean));
  const prefixes=parts.map(p=>p.slice(0,-1).map(normalize).join('\n'));
  if (parts.every(p=>p.length>=2) && prefixes[0] && prefixes.every(p=>p===prefixes[0])) keys=parts.map(p=>labelKey(p.at(-1)!));
  const columns=new Map<string,number>();let duplicate=false;
  for(const [field,aliases] of Object.entries(COLUMNS)) {
    const indices=keys.flatMap((key,i)=>aliases.includes(key)?[i]:[]);
    if(indices.length>1) duplicate=true;
    if(indices.length===1) columns.set(field,indices[0]!);
  }
  const unknown=keys.some((key,i)=>key && ![...columns.values()].includes(i));
  return {columns,duplicate,unknown,keys};
}
const summaryLabels = new Set([...Object.entries(FIELD_LABELS).filter(([field])=>field.endsWith('Cents')).flatMap(([,aliases])=>aliases.map(labelKey)), 'totaldue','balancedue','remainingbalance']);
function summaryRow(row: string[]) {
  const labels=row.flatMap((value,index)=>summaryLabels.has(labelKey(value))?[index]:[]);
  if(labels.length!==1) return false;
  const index=labels[0]!;
  const after=row.slice(index+1).filter(Boolean);
  if(after.length!==1 || money(after[0]!)===null) return false;
  // Notes may share a merged footer row, but actual quantity/SKU data may not disappear.
  return row.slice(0,index).filter(Boolean).every(value=>/^(?:Delivery Reference|Work reference|PO Reference|Terms|Currency)\s*:/i.test(value));
}
function titleRow(row: unknown[]) {
  const values=row.map(clean).filter(Boolean);
  return values.length>0 && new Set(values.map(normalize)).size===1 && !/\d/.test(values[0]!);
}
export function tableLines(output: ProviderOutput, issues: string[] = []): ExtractedTableLine[] {
  const result: ExtractedTableLine[]=[];
  for(const page of output.result.items?.pages ?? []) for(const [ii,item] of (page.items ?? []).entries()) {
    if(item.type!=='table' || !Array.isArray(item.rows) || !item.rows.length) continue;
    let header=-1;let columns=new Map<string,number>();
    for(let index=0;index<Math.min(6,item.rows.length);index++) {
      if (!Array.isArray(item.rows[index])) {issues.push("invalid_line_table_row");break;}
      const candidate=columnMap(item.rows[index]);
      if(candidate.duplicate) {issues.push('ambiguous_line_table_columns');break;}
      if(candidate.columns.size===6) {
        if(candidate.unknown) {issues.push('unsupported_line_table_columns');break;}
        header=index;columns=candidate.columns;break;
      }
      if(candidate.columns.size>=2) {issues.push('unsupported_line_table_columns');break;}
      if(!titleRow(item.rows[index])) break;
    }
    if(header<0) continue;
    const grounded=output.grounded.find(p=>p.page_number===page.page_number)?.items?.[ii];
    let sawSummary=false;
    for(let ri=header+1;ri<item.rows.length;ri++) {
      const rawRow=item.rows[ri] as unknown[];
      if (!Array.isArray(rawRow)) {issues.push("invalid_line_table_row");continue;}
      const row=rawRow.map(clean);
      if(row.every(value=>!value)) continue;
      if(summaryRow(row)) {sawSummary=true;continue;}
      const repeated=columnMap(rawRow);
      if(repeated.columns.size===6 && !repeated.duplicate && !repeated.unknown) {
        if(JSON.stringify([...repeated.columns])!==JSON.stringify([...columns])) issues.push('changed_line_table_columns');
        continue;
      }
      if(sawSummary) issues.push('line_data_after_summary');
      if(row.some((value,index)=>value && ![...columns.values()].includes(index))) issues.push('unmapped_line_cell');
      const cells=new Map<string,{text:string;hint?:NativeRegion}>();
      for(const [field,ci] of columns) {
        const text=row[ci] ?? '';
        const rawText=String(grounded?.rows?.[ri]?.[ci] ?? '');
        const cell=grounded?.grounding?.rows?.[ri]?.[ci];
        const regions=cell ? cellNativeRegions(rawText,cell) : undefined;
        const hint=regions && normalize(rawText)===normalize(text) ? {text,page:page.page_number,regions} : undefined;
        cells.set(field,{text,hint});
      }
      const val=(field:string)=>cells.get(field)!.text;
      const quantity=val('quantity'),price=money(val('unitPriceCents')),amount=money(val('amountCents'));
      if(!val('sku') || !val('description') || !/^\d{1,18}(?:\.\d{1,6})?$/.test(quantity) || price===null || amount===null || !val('unit')) {
        issues.push(`unparsed_line_row_page_${page.page_number}_row_${ri}`);continue;
      }
      if(!exactLineAmount(quantity,price,amount)) issues.push(`line_amount_arithmetic_mismatch_page_${page.page_number}_row_${ri}`);
      result.push({sku:val('sku'),description:val('description'),quantity,unit:val('unit'),unitPriceCents:price,amountCents:amount,page:page.page_number,cells});
    }
  }
  return result;
}
