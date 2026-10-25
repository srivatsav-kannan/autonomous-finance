import { describe, it, expect } from 'vitest';
import { headerFields, tableLines, money, exactLineAmount } from './document-mapping';
import { extractCandidate } from './extraction';
import type { ProviderOutput } from './provider';
import type { SourceDocument } from '../contracts';
const hash='0'.repeat(64);
const processor={provider:'llamaparse',model:'test',version:'2026-09-28',configHash:hash,jobId:'test-only',resolvedVersion:null,implementationVersion:'test',configArtifact:null,rawArtifact:null,tokenArtifact:null,rasterArtifact:null,traineddata:null};
const columns=['SKU','Description','Qty','UOM','Unit Price','Amount'];
const economic=['PART-Z','Test component','0.125','box','32.00','4.00'];
const header='Supplier: Example Operations LLC    Invoice Number: TEST-903\nInvoice Date: 2026-09-10    Due Date: 2026-10-10    Terms: Net 30\nCurrency: USD';
const totals='Subtotal: USD 4.00\nTax: USD 0.00\nFreight: USD 0.75\nDiscount: USD 0.25\nGrand Total: USD 4.50';
function output(markdown=header+'\n'+totals, rows:unknown[][]=[columns,economic]):ProviderOutput {
 return {result:{markdown_full:markdown,items:{pages:[{page_number:1,page_width:612,page_height:792,success:true,items:[{type:'table',rows}]}]}},grounded:[],rawWords:[],processor,reused:true};
}
const source:SourceDocument={sourceId:'test-source',revision:1,sha256:hash,deliveryId:'test-delivery',name:'test.pdf',kind:'invoice',mimeType:'application/pdf',originalRef:'unused',byteLength:1,extractedText:'',provenance:{kind:'synthetic',description:'independent unit scenario',license:'test',originalFilename:'test.pdf'},replaces:null,pageCount:1,pageStatus:[{page:1,status:'complete',reason:null}],parser:processor};
const context={supplier:{supplierId:'example',legalName:'Example Operations LLC'},coding:{account:'5000',store:'test-store',department:null,project:null,treatment:'expense' as const}};
const extract=(o:ProviderOutput)=>extractCandidate(source,o,'/tmp',context,false);

describe('explicit header/value mapping',()=>{
 it('separates adjacent header labels without borrowing the due date',()=>{
  const fields=headerFields(output());
  expect(fields.invoiceNumber).toBe('TEST-903');expect(fields.invoiceDate).toBe('2026-09-10');expect(fields.dueDate).toBe('2026-10-10');expect(fields.extractedSupplierName).toBe('Example Operations LLC');
 });
 it('does not infer invoice date from a due date',async()=>{
  const r=await extract(output(header.replace('Invoice Date: 2026-09-10    ','')+'\n'+totals));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons).toContain('missing_invoiceDate');
 });
 it.each(['Invoice Date','Due Date'])('holds conflicting repeated %s, including optional fields',async label=>{
  const r=await extract(output(header+'\n'+totals+'\n'+label+': 2026-12-11'));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons).toContain('ambiguous_'+(label==='Invoice Date'?'invoiceDate':'dueDate'));
 });
 it.each(['09/10/2026','2026-02-30','2026-09-10 Due 2026-10-10'])('holds ambiguous/invalid invoice date %s',async value=>{
  const r=await extract(output((header+'\n'+totals).replace('Invoice Date: 2026-09-10','Invoice Date: '+value)));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons).toContain('invalid_invoiceDate');
 });
 it('holds an explicitly malformed due date rather than dropping it as optional',async()=>{
  const r=await extract(output((header+'\n'+totals).replace('Due Date: 2026-10-10','Due Date: unreadable')));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons).toContain('invalid_dueDate');
 });
 it('uses exact financial labels, ignoring prose and total-due semantics',()=>{
  const fields=headerFields(output('Freight is billed separately.\nFreight: 0.75\nDiscount: 0.25\nTotal Due: 9.00\nSubtotal savings are illustrative.'));
  expect(fields.freightCents).toBe('0.75');expect(fields.discountCents).toBe('0.25');expect(fields.totalCents).toBeNull();expect(fields.subtotalCents).toBeNull();
 });
 it('preserves a conflict when prose is explicitly supplied as the labeled amount',async()=>{
  const r=await extract(output(header+'\n'+totals+'\nFreight: see shipping note'));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons).toContain('ambiguous_freightCents');
 });
 it('accepts equivalent exact monetary spellings and rejects conflicting values',()=>{
  expect(headerFields(output('Freight: USD 0.75\nFreight: $0.75')).issues).toEqual([]);
  expect(headerFields(output('Freight: USD 0.75\nFreight: $0.76')).issues).toContain('ambiguous_freightCents');
 });
 it('reads sparse HTML rows and inline metadata without inventing values',()=>{
  const fields=headerFields(output('<table><tr><td>Terms: Net 15</td><td colspan="2">Freight</td><td></td><td>USD 0.75</td></tr><tr><td>Grand Total</td><td>USD 4.50</td></tr></table>'));
  expect(fields.terms).toBe('Net 15');expect(fields.freightCents).toBe('USD 0.75');expect(fields.totalCents).toBe('USD 4.50');
 });
 it('does not cross another labeled cell to find a value',()=>{
  const fields=headerFields(output('| Invoice Date | Due Date | 2026-10-10 |'));
  expect(fields.invoiceDate).toBeNull();expect(fields.dueDate).toBe('2026-10-10');
 });
});

describe('column mapping and explicit footers',()=>{
 it('maps reordered columns below a common spanning title',()=>{
  const indices=[2,3,1,0,4,5];
  const issues:string[]=[];
  const rows=tableLines(output('',[indices.map(i=>'PARTS PROVIDED<br/>'+columns[i]),indices.map(i=>economic[i])]),issues);
  expect(issues).toEqual([]);expect(rows[0]).toMatchObject({sku:'PART-Z',quantity:'0.125',unit:'box',unitPriceCents:3200,amountCents:400});
 });
 it('accepts a standalone title and repeated identical column header',()=>{
  const issues:string[]=[];const rows=tableLines(output('',[['LINE ITEMS'],columns,economic,columns,economic]),issues);
  expect(issues).toEqual([]);expect(rows).toHaveLength(2);
 });
 it('does not strip different prefix text from each column',()=>{
  const issues:string[]=[];const rows=tableLines(output('',[columns.map((c,i)=>'Different '+i+'<br/>'+c),economic]),issues);
  expect(rows).toEqual([]);
 });
 it.each([
  [['SKU','Description','Qty','Quantity','UOM','Price','Amount'],['A','B','1','1','box','4.00','4.00']],
  [['SKU','Description','Qty','UOM','Unit Price','Rate','Amount'],['A','B','1','box','4.00','4.00','4.00']],
 ])('rejects duplicate aliases instead of choosing the first column',(heading,data)=>{
  const issues:string[]=[];expect(tableLines(output('',[heading,data]),issues)).toEqual([]);expect(issues).toContain('ambiguous_line_table_columns');
 });
 it('holds extra unsupported populated columns',()=>{
  const issues:string[]=[];expect(tableLines(output('',[[...columns,'Tax'],[...economic,'0.01']]),issues)).toEqual([]);expect(issues).toContain('unsupported_line_table_columns');
 });
 it('recognizes one exact summary pair at any sparse column positions with labeled notes',()=>{
  const issues:string[]=[];const rows=tableLines(output('',[columns,economic,['Work reference: JOB-41','','Subtotal','','4.00',''],['','','Grand Total','','4.50','']]),issues);
  expect(issues).toEqual([]);expect(rows).toHaveLength(1);
 });
 it('does not discard an economic row whose SKU is TOTAL',()=>{
  const issues:string[]=[];const rows=tableLines(output('',[columns,['TOTAL',...economic.slice(1)]]),issues);
  expect(issues).toEqual([]);expect(rows).toHaveLength(1);expect(rows[0]?.sku).toBe('TOTAL');
 });
 it('holds a purported footer with unlabeled leftover economic content',()=>{
  const issues:string[]=[];tableLines(output('',[columns,economic,['PART-A','','Subtotal','','4.00','']]),issues);
  expect(issues.some(x=>x.startsWith('unparsed_line_row'))).toBe(true);
 });
 it('holds changed column order mid-table',()=>{
  const issues:string[]=[];tableLines(output('',[columns,economic,[columns[0]!,columns[1]!,columns[4]!,columns[3]!,columns[2]!,columns[5]!],economic]),issues);
  expect(issues).toContain('changed_line_table_columns');
 });
});

describe('exact document arithmetic',()=>{
 it.each(['12,34.00','1e2','0.001','-1.00','9007199254740993.00','4.00 USD?'])('rejects non-exact money %s',value=>expect(money(value)).toBeNull());
 it('keeps fractional quantities exact without rounding a fractional cent',()=>{
  expect(exactLineAmount('0.125',3200,400)).toBe(true);expect(exactLineAmount('0.125',3201,400)).toBe(false);expect(exactLineAmount('1e2',1,100)).toBe(false);
 });
 it('maps reconciled freight/discount to explicit trusted coding',async()=>{
  const r=await extract(output());expect(r.candidate?.totalCents).toBe(450);
  expect(r.candidate?.freightAllocations).toEqual([{...context.coding,amountCents:75,period:'2026-09'}]);
  expect(r.candidate?.discountAllocations).toEqual([{...context.coding,amountCents:25,period:'2026-09'}]);
 });
 it('holds a line amount mismatch even if the document total is self-consistent',async()=>{
  const row=[...economic];row[4]='32.01';const r=await extract(output(undefined,[columns,row]));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons.some(x=>x.startsWith('line_amount_arithmetic_mismatch'))).toBe(true);
 });
 it('holds a subtotal inconsistent with the retained line amounts',async()=>{
  const r=await extract(output((header+'\n'+totals).replace('Subtotal: USD 4.00','Subtotal: USD 4.01').replace('Grand Total: USD 4.50','Grand Total: USD 4.51')));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons).toContain('subtotal_arithmetic_mismatch');
 });
 it.each(['Grand Total: USD 4.49','Grand Total: USD 4.51'])('holds total inconsistency %s',async total=>{
  const r=await extract(output((header+'\n'+totals).replace('Grand Total: USD 4.50',total)));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons).toContain('total_arithmetic_mismatch');
 });
 it('never infers a missing discount from total subtraction',async()=>{
  const r=await extract(output((header+'\n'+totals).replace('Discount: USD 0.25\n','')));
  expect(r.candidate).toBeNull();expect(r.extraction.reasons).toContain('missing_or_ambiguous_discountCents');
 });
});
