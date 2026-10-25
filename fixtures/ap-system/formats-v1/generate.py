"""Project-authored synthetic format controls. No provider outputs or evaluation results are inputs."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image,ImageFilter,ImageEnhance
import subprocess,json,hashlib,io
root=Path(__file__).resolve().parent;inputs=root/'input';inputs.mkdir(exist_ok=True)
original=root.parent/'golden-state-v1/input/invoice.pdf'
sha=lambda b:hashlib.sha256(b).hexdigest()
assert sha(original.read_bytes())=='a6c745ac1f33d32ab142f8da420ba82af3590eb36a3897c39d7537d1c0a1eb83'
work=root/'generation-work';work.mkdir(exist_ok=True)
subprocess.run(['pdftoppm','-r','144','-singlefile','-png',str(original),str(work/'original')],check=True,capture_output=True)
scan=ImageEnhance.Contrast(Image.open(work/'original.png').convert('L').filter(ImageFilter.GaussianBlur(.35))).enhance(.9)
scan.save(inputs/'invoice-scan.png',optimize=True)
scan.save(inputs/'invoice-scan.jpg',quality=70,subsampling=0,optimize=True)
c=canvas.Canvas(str(inputs/'invoice-scanned.pdf'),pagesize=(612,792),invariant=1,pageCompression=1);c.setTitle('Synthetic raster-only invoice control');c.drawImage(ImageReader(scan),0,0,612,792);c.showPage();c.save()
lines=[('KALE-24','Organic Kale, 24ct case','5','case','38.50','192.50'),('ROM-CS','Romaine Hearts, case','4','case','42.75','171.00'),('AVO-48','Hass Avocados, 48ct','3','case','68.90','206.70'),('TOM-25','Heirloom Tomatoes, 25lb','2','case','54.20','108.40')]
c=canvas.Canvas(str(inputs/'multipage-layout.pdf'),pagesize=(612,792),invariant=1,pageCompression=1);c.setTitle('Synthetic ordered two-page invoice source')
for page in [1,2]:
 c.setFont('Helvetica-Bold',20);c.drawString(42,742,'Golden State Produce Co.')
 c.setFont('Helvetica',10);c.drawString(42,720,'SYNTHETIC FORMAT CONTROL - not an actual supplier original')
 c.setFont('Helvetica-Bold',17);c.drawString(42,682,'INVOICE')
 headers=[('Document Number','FMT-MULTI-1001'),('Supplier','Golden State Produce Co.'),('Invoice Date','2026-10-19'),('Due Date','2026-11-02'),('Terms','Net 14'),('Currency','USD')]
 c.setFont('Helvetica',11)
 for i,(k,v) in enumerate(headers):c.drawString(42,653-i*20,k+':');c.drawString(170,653-i*20,v)
 xs=[42,121,350,386,430,514];y=497
 c.setFillColorRGB(.9,.94,.92);c.rect(36,y-14,540,32,fill=1,stroke=0);c.setFillColorRGB(0,0,0);c.setFont('Helvetica-Bold',10)
 for x,v in zip(xs,['SKU','Description','Qty','UOM','Unit USD','Amount USD']):c.drawString(x,y,v)
 c.setFont('Helvetica',10)
 for i,row in enumerate(lines[(page-1)*2:page*2]):
  for x,v in zip(xs,row):c.drawString(x,450-i*42,v)
 if page==2:
  for i,(k,v) in enumerate([('Subtotal','678.60'),('Tax','0.00'),('Freight','0.00'),('Discount','0.00'),('Total','678.60')]):c.drawString(396,330-i*24,k);c.drawRightString(568,330-i*24,'USD '+v)
 c.setFont('Helvetica',10);c.drawString(42,70,'All counterparties and amounts are project-authored synthetic controls.');c.drawString(42,52,f'FORMAT-PAGE-{page} / {page} of 2');c.showPage()
c.save()
subprocess.run(['pdftoppm','-r','144','-png',str(inputs/'multipage-layout.pdf'),str(work/'multi')],check=True,capture_output=True)
frames=[Image.open(work/f'multi-{i}.png').convert('L') for i in [1,2]]
frames[0].save(inputs/'invoice-two-page.tiff',save_all=True,append_images=frames[1:],compression='tiff_deflate',dpi=(144,144))
unreadable=Image.new('L',scan.size,255)
from PIL import ImageDraw
ImageDraw.Draw(unreadable).text((80,80),'SYNTHETIC UNREADABLE CONTROL: invoice content deliberately absent',fill=0)
unreadable.save(inputs/'invoice-unreadable.png',optimize=True)
# Published input facts and independent evaluation profile are frozen before parsing.
profiles={
 'native-pdf':{'candidate':True,'pages':1,'invoiceNumber':'INV-1001','totalCents':67860,'lineCount':4,'quantities':['5','4','3','2']},
 'scanned-pdf':{'candidate':True,'pages':1,'invoiceNumber':'INV-1001','totalCents':67860,'lineCount':4,'quantities':['5','4','3','2']},
 'png':{'candidate':True,'pages':1,'invoiceNumber':'INV-1001','totalCents':67860,'lineCount':4,'quantities':['5','4','3','2']},
 'jpeg':{'candidate':True,'pages':1,'invoiceNumber':'INV-1001','totalCents':67860,'lineCount':4,'quantities':['5','4','3','2']},
 'multipage-tiff':{'candidate':True,'pages':2,'invoiceNumber':'FMT-MULTI-1001','totalCents':67860,'lineCount':4,'quantities':['5','4','3','2'],'orderedPageMarkers':['FORMAT-PAGE-1','FORMAT-PAGE-2']},
 'unreadable-png':{'candidate':False,'pages':1,'reason':'Required content intentionally absent'},
 'ubl-positive-tax':{'candidate':True,'pages':1,'invoiceNumber':'FMT-XML-01','totalCents':1890,'subtotalCents':1750,'taxCents':140,'lineCount':2,'quantities':['2.5','3'],'lineTaxes':[80,60],'allocations':[1080,810],'geometry':'xml_path'},
 'ubl-unknown-profile':{'candidate':False,'pages':1,'reason':'xml_unsupported_profile'}
}
(root/'evaluation/expected-profiles.json').write_text(json.dumps({'frozenBeforeProvider':True,'review':'project_authored_policy_derived_not_independent_acceptance','profiles':profiles},indent=2)+'\n')
# XML is independently authored, including stated positive tax and fractional quantity.
ubl='urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';cbc='urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';cac='urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2'
xml=f'''<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="{ubl}" xmlns:cbc="{cbc}" xmlns:cac="{cac}">
 <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
 <cbc:CustomizationID>urn:autonomous-finance:ap:ubl-2.1:invoice:v1</cbc:CustomizationID>
 <cbc:ProfileID>urn:autonomous-finance:ap:invoice:usd-explicit-tax:v1</cbc:ProfileID>
 <cbc:ID>FMT-XML-01</cbc:ID><cbc:IssueDate>2026-10-25</cbc:IssueDate><cbc:DueDate>2026-11-08</cbc:DueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>
 <cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Format Test Supplies LLC</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
 <cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Project Synthetic Buyer</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
 <cac:PaymentTerms><cbc:Note>Net 14</cbc:Note></cac:PaymentTerms>
 <cac:TaxTotal><cbc:TaxAmount currencyID="USD">1.40</cbc:TaxAmount></cac:TaxTotal>
 <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="USD">17.50</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="USD">17.50</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="USD">18.90</cbc:TaxInclusiveAmount><cbc:AllowanceTotalAmount currencyID="USD">0.00</cbc:AllowanceTotalAmount><cbc:ChargeTotalAmount currencyID="USD">0.00</cbc:ChargeTotalAmount><cbc:PayableAmount currencyID="USD">18.90</cbc:PayableAmount></cac:LegalMonetaryTotal>
'''
for i,qty,price,amount,tax,sku,desc in [(1,'2.5','4.00','10.00','0.80','TEST-PAPER','Paper towels'),(2,'3','2.50','7.50','0.60','TEST-CLEAN','Sanitizer refills')]:
 xml+=f' <cac:InvoiceLine><cbc:ID>{i}</cbc:ID><cbc:InvoicedQuantity unitCode="C62">{qty}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="USD">{amount}</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="USD">{tax}</cbc:TaxAmount></cac:TaxTotal><cac:Item><cbc:Description>{desc}</cbc:Description><cac:SellersItemIdentification><cbc:ID>{sku}</cbc:ID></cac:SellersItemIdentification></cac:Item><cac:Price><cbc:PriceAmount currencyID="USD">{price}</cbc:PriceAmount><cbc:BaseQuantity unitCode="C62">1</cbc:BaseQuantity></cac:Price></cac:InvoiceLine>\n'
xml+='</Invoice>\n';(inputs/'invoice-ubl.xml').write_text(xml);(inputs/'invoice-unknown-profile.xml').write_text(xml.replace('usd-explicit-tax:v1','unrecognized:v9'))
specs=[('native-pdf','../golden-state-v1/input/invoice.pdf','application/pdf','native PDF reused by immutable hash'),('scanned-pdf','input/invoice-scanned.pdf','application/pdf','Raster-only synthetic scan proxy from native PDF; not genuine archival scan'),('png','input/invoice-scan.png','image/png','Grayscale blur/contrast synthetic scan proxy'),('jpeg','input/invoice-scan.jpg','image/jpeg','Lossy JPEG quality70 scan proxy'),('multipage-tiff','input/invoice-two-page.tiff','image/tiff','Two distinct ordered grayscale pages, deflate TIFF'),('unreadable-png','input/invoice-unreadable.png','image/png','Intentionally absent invoice content negative control'),('ubl-positive-tax','input/invoice-ubl.xml','application/xml','Project-authored declared UBL2.1 subset, explicit positive tax'),('ubl-unknown-profile','input/invoice-unknown-profile.xml','application/xml','Unknown profile negative control')]
manifest={'version':'formats-v1','provenance':'synthetic','license':'Project-authored engineering controls; no actual supplier data','generator':'generate.py; ReportLab + Pillow + pdftoppm','sources':[{'id':i,'path':p,'mimeType':m,'sha256':sha((root/p).read_bytes()),'byteLength':(root/p).stat().st_size,'description':d} for i,p,m,d in specs],'expectedResultsFile':'evaluation/expected-profiles.json','expectedResultsAccess':'evaluation_only_not_runtime','baseNativeSha256':sha(original.read_bytes())}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
import shutil
shutil.rmtree(work)
print(json.dumps({'sources':len(specs),'totalBytes':sum(s['byteLength'] for s in manifest['sources'])}))
