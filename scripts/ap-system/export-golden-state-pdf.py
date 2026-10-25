"""Render frozen synthetic business facts. Does not read evaluation labels."""
import json,sys
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.utils import simpleSplit
root=Path(sys.argv[1]); f=json.loads((root/'input/facts.json').read_text())
W,H=612,792
ink=HexColor('#15332e'); muted=HexColor('#5c6c67'); pale=HexColor('#eaf0ed')
def money(n):return f'{n/100:,.2f}'
def render(kind,title,number,variant=False):
 path=root/'input'/f'{kind}.pdf'; c=canvas.Canvas(str(path),pagesize=(W,H),invariant=1,pageCompression=1)
 c.setTitle(f'Synthetic {title} {number}');c.setAuthor('Autonomous Finance synthetic fixture generator')
 c.setFillColor(ink);c.rect(0,H-9,W,9,fill=1,stroke=0)
 c.setFont('Helvetica-Bold',19);c.drawString(42,742,'Golden State Produce Co.')
 c.setFont('Helvetica',9);c.setFillColor(muted);c.drawString(42,725,'SYNTHETIC COMPANY DOCUMENT / AP ENGINEERING FIXTURE')
 c.setFillColor(ink);c.setFont('Helvetica-Bold',22);c.drawString(42,680,title)
 c.setFont('Helvetica',10);c.drawString(42,659,f'Document Number: {number}')
 labels=[('Supplier',f['supplier']['legalName']),('Bill To',f['billTo']),('Store',f['store']),('Invoice Date',f['invoiceDate']),('Due Date',f['dueDate']),('Terms',f['terms']),('Currency','USD'),('PO Reference',f['purchaseOrder']),('Delivery Reference',f['deliveryReference'])]
 if kind=='receipt':labels[1]=('Received At',f['billTo'])
 y=630
 for label,value in labels:
  c.setFont('Helvetica-Bold',9);c.drawString(42,y,label+':');c.setFont('Helvetica',9);c.drawString(139,y,str(value));y-=16
 y-=18;c.setFillColor(pale);c.rect(42,y-6,528,25,fill=1,stroke=0);c.setFillColor(ink);c.setFont('Helvetica-Bold',8)
 for x,text in [(48,'SKU'),(116,'Description'),(355,'Qty'),(390,'UOM'),(438,'Unit USD'),(512,'Amount USD')]:c.drawString(x,y+3,text)
 y-=28;total=0
 for line in f['lines']:
  q=int(line['quantity'])+(1 if variant and line['sku']=='KALE-24' else 0);amount=q*line['unitPriceCents'];total+=amount
  c.setFont('Helvetica',8.5);c.drawString(48,y,line['sku']);wrapped=simpleSplit(line['description'],'Helvetica',8.5,225)
  for j,t in enumerate(wrapped):c.drawString(116,y-j*12,t)
  c.drawRightString(373,y,str(q));c.drawString(390,y,line['unit']);c.drawRightString(484,y,money(line['unitPriceCents']));c.drawRightString(564,y,money(amount))
  y-=max(35,15+len(wrapped)*12);c.setStrokeColor(pale);c.line(42,y+14,570,y+14)
 if kind=='receipt':
  c.setFont('Helvetica-Bold',10);c.drawString(42,y-12,'Goods received in the quantities above.')
  c.setFont('Helvetica',9);c.drawString(42,y-31,'Receiving owner: Fixture Receiving Operator (simulated)')
  c.drawString(42,y-47,'Acceptance recorded: 2026-10-19T10:00:00Z')
 else:
  for label,value in [('Subtotal',total),('Tax',0),('Freight',0),('Discount',0),('Total',total)]:
   c.setFont('Helvetica-Bold' if label=='Total' else 'Helvetica',10);c.drawString(412,y,label);c.drawRightString(564,y,'USD '+money(value));y-=19
 if kind=='contract':
  c.setFont('Helvetica',9);c.drawString(42,160,'Effective: 2026-01-01 through 2026-12-31. Unit prices listed above apply.')
  c.drawString(42,145,'Terms: Net 14. This contract is explicitly authored synthetic support.')
 elif kind=='purchase-order':
  c.setFont('Helvetica',9);c.drawString(42,160,'Authorized purchasing owner: Fixture Purchasing Operator (simulated).')
  c.drawString(42,145,'This PO is authored synthetic support linked to the exported delivery event.')
 c.setStrokeColor(pale);c.line(42,95,570,95);c.setFillColor(muted);c.setFont('Helvetica',8)
 c.drawString(42,78,'All counterparties, people and transactions are simulated. Not an actual supplier original.')
 c.drawString(42,65,'Source: seeded company simulator; printed values frozen before parser evaluation.');c.drawRightString(570,48,'1 / 1')
 c.save()
render('invoice','INVOICE',f['invoiceNumber'])
render('purchase-order','PURCHASE ORDER',f['purchaseOrder'])
render('receipt','GOODS RECEIPT',str(f['deliveryReference']))
render('contract','SUPPLY CONTRACT',f['contractReference'])
render('invoice-quantity-discrepancy','INVOICE','INV-1001-QTY',True)
