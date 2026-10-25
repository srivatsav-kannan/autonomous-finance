"""Author synthetic originals only. Never reads evaluation expectations or parser output."""
from pathlib import Path
from decimal import Decimal
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.utils import simpleSplit, ImageReader
from PIL import Image, ImageFilter, ImageEnhance, ImageDraw
import hashlib, json, tempfile, subprocess, sys

root = Path(__file__).resolve().parent
out = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root
(out / 'input').mkdir(parents=True, exist_ok=True)
facts = json.loads((root / 'authoring/facts.json').read_text())
sha = lambda b: hashlib.sha256(b).hexdigest()
money = lambda cents: f'{Decimal(cents)/100:,.2f}'

def text(c,x,y,value,size=10,font='Helvetica',color=black):
    c.setFillColor(color); c.setFont(font,size); c.drawString(x,y,value)
def right(c,x,y,value,size=10,font='Helvetica',color=black):
    c.setFillColor(color); c.setFont(font,size); c.drawRightString(x,y,value)
def line(c,x1,y1,x2,y2,color='#ced4d9'):
    c.setStrokeColor(HexColor(color)); c.line(x1,y1,x2,y2)
def validate(f):
    for row in f['lines']:
        assert Decimal(row['quantity'])*row['unitPriceCents']==row['amountCents']
    assert sum(r['amountCents'] for r in f['lines'])==f['subtotalCents']
    assert f['subtotalCents']+f['taxCents']+f['freightCents']-f['discountCents']==f['totalCents']

def landscape(f, file):
    w,h=792,612;c=canvas.Canvas(str(file),pagesize=(w,h),invariant=1,pageCompression=1)
    c.setTitle(f"Synthetic held-out invoice {f['invoiceNumber']}"); c.setAuthor('Autonomous Finance project-authored synthetic fixtures')
    c.setFillColor(HexColor('#182f4b'));c.rect(0,h-100,w,100,fill=1,stroke=0)
    text(c,36,566,f['supplier'],25,'Helvetica-Bold',white)
    text(c,37,544,'TEXTILE SUPPLY / PROJECT-AUTHORED SYNTHETIC COMPANY',9,color=white)
    right(c,755,520,'INVOICE',17,'Helvetica-Bold',white)
    text(c,36,484,'Supplier: '+f['supplier'],10,'Helvetica-Bold')
    text(c,36,464,'Bill To: '+f['buyer'],10)
    text(c,36,444,'PO Reference: '+f['purchaseOrder'],10)
    text(c,300,464,'Invoice Date: '+f['invoiceDate'],10)
    text(c,300,444,'Due Date: '+f['dueDate'],10)
    text(c,556,484,'Invoice Number: '+f['invoiceNumber'],11,'Helvetica-Bold')
    text(c,556,464,'Terms: '+f['terms'],10)
    text(c,556,444,'Currency: '+f['currency'],10)
    # Different column order from Golden State; ample spacing for decimal quantities.
    cols=[(36,68,'Quantity'),(104,76,'UOM'),(180,283,'Description'),(463,99,'SKU'),(562,95,'Unit Price'),(657,99,'Amount')]
    c.setFillColor(HexColor('#e8eef4'));c.rect(36,377,720,32,fill=1,stroke=0)
    for x,width,label in cols:text(c,x+8,389,label,10,'Helvetica-Bold')
    for i,r in enumerate(f['lines']):
        y=356-i*45
        for x,key in [(44,'quantity'),(112,'unit'),(188,'description'),(471,'sku')]:text(c,x,y,r[key],10)
        right(c,644,y,money(r['unitPriceCents']),11)
        right(c,748,y,money(r['amountCents']),11)
        line(c,36,y-16,756,y-16)
    text(c,36,245,'Delivery Reference: '+f['deliveryReference'],10)
    text(c,36,222,'Freight is stated separately; discount reduces the invoice total.',9)
    text(c,36,204,'No tax is charged on this authored control.',9)
    for i,(key,label) in enumerate([('subtotalCents','Subtotal'),('taxCents','Tax'),('freightCents','Freight'),('discountCents','Discount'),('totalCents','Grand Total')]):
        y=256-i*25; bold=key=='totalCents'
        text(c,540,y,label,11,'Helvetica-Bold' if bold else 'Helvetica');right(c,748,y,'USD '+money(f[key]),12 if bold else 11,'Helvetica-Bold' if bold else 'Helvetica')
    line(c,36,98,756,98)
    text(c,36,77,'SYNTHETIC TEST DOCUMENT - not payable and not an actual supplier original.',9,'Helvetica-Bold')
    text(c,36,60,'All parties and transactions are invented. Held-out layout control HT / 1 of 1.',8)
    c.showPage();c.save()

def portrait(f,file):
    w,h=612,792;c=canvas.Canvas(str(file),pagesize=(w,h),invariant=1,pageCompression=1)
    c.setTitle(f"Synthetic held-out invoice {f['invoiceNumber']}");c.setAuthor('Autonomous Finance project-authored synthetic fixtures')
    text(c,40,746,'COPPER VALVE',27,'Times-Bold')
    text(c,40,726,'MAINTENANCE SERVICES',11,'Times-Roman')
    right(c,574,746,'INVOICE',17,'Courier-Bold')
    right(c,574,724,f['invoiceNumber'],15,'Courier')
    line(c,40,706,574,706,'#222222')
    text(c,40,682,'Supplier: '+f['supplier'],10,'Helvetica-Bold')
    text(c,40,661,'Bill To: '+f['buyer'],10)
    text(c,40,640,'Invoice Number: '+f['invoiceNumber'],10)
    text(c,335,661,'Invoice Date: '+f['invoiceDate'],10)
    text(c,335,640,'Due Date: '+f['dueDate'],10)
    text(c,40,608,'SERVICE DETAIL',12,'Courier-Bold')
    # Classic portrait service ledger with wrapped descriptions and monospace money.
    xs=[40,102,315,365,421,504];labels=['SKU','Description','Quantity','UOM','Rate','Line Total']
    line(c,40,595,574,595,'#222222')
    for x,v in zip(xs,labels):text(c,x,580,v,9,'Helvetica-Bold')
    line(c,40,571,574,571,'#222222')
    for i,r in enumerate(f['lines']):
        y=547-i*61
        text(c,40,y,r['sku'],9,'Courier')
        for j,t in enumerate(simpleSplit(r['description'],'Helvetica',10,197)):text(c,102,y-j*13,t,10)
        right(c,348,y,r['quantity'],10,'Courier');text(c,365,y,r['unit'],9)
        right(c,480,y,money(r['unitPriceCents']),10,'Courier');right(c,574,y,money(r['amountCents']),10,'Courier')
        line(c,40,y-35,574,y-35,'#e0e0e0')
    text(c,40,330,'Work reference: '+f['deliveryReference'],10)
    text(c,40,310,'PO Reference: '+f['purchaseOrder'],10)
    text(c,40,290,'Terms: '+f['terms'],10)
    text(c,40,270,'Currency: '+f['currency'],10)
    for i,(key,label) in enumerate([('subtotalCents','Subtotal'),('taxCents','Tax'),('freightCents','Freight'),('discountCents','Discount'),('totalCents','Total')]):
        y=330-i*25;bold=key=='totalCents'
        text(c,365,y,label,10,'Helvetica-Bold' if bold else 'Helvetica');right(c,574,y,'USD '+money(f[key]),11,'Courier-Bold' if bold else 'Courier')
    line(c,40,188,574,188,'#222222')
    text(c,40,163,'SYNTHETIC TEST DOCUMENT - NOT PAYABLE',10,'Helvetica-Bold')
    for i,t in enumerate(['No actual technician, supplier or customer is represented.','Amounts and service descriptions were authored for a parser evaluation.','No purchase, approval, bank instruction or real work order is created.']):text(c,40,143-i*15,t,9)
    right(c,574,65,'Held-out layout control CV / 1 of 1',8)
    c.showPage();c.save()

sources=[]
with tempfile.TemporaryDirectory(prefix='ap-heldout-generate-') as work:
    for f in facts['invoices']:
        validate(f);native=out/'input'/f"{f['id']}-native.pdf"
        (landscape if f['layout']=='landscape-ledger' else portrait)(f,native)
        prefix=Path(work)/f['id']
        subprocess.run(['pdftoppm','-r','144','-singlefile','-png',str(native),str(prefix)],check=True,capture_output=True)
        image=Image.open(str(prefix)+'.png').convert('L')
        # Reproducible scan proxy: grayscale, mild blur/contrast loss, deterministic light streaks.
        image=ImageEnhance.Contrast(image.filter(ImageFilter.GaussianBlur(.40))).enhance(.86)
        draw=ImageDraw.Draw(image)
        for x in range(71,image.width,223):draw.line((x,0,x,image.height),fill=232,width=1)
        scan=out/'input'/f"{f['id']}-scan.pdf"
        dims=(792,612) if f['layout']=='landscape-ledger' else (612,792)
        c=canvas.Canvas(str(scan),pagesize=dims,invariant=1,pageCompression=1)
        c.setTitle(f"Synthetic image-only scan proxy {f['invoiceNumber']}");c.setAuthor('Autonomous Finance project-authored synthetic fixtures')
        c.drawImage(ImageReader(image),0,0,*dims);c.showPage();c.save()
        for variant,pdf in [('native',native),('scan',scan)]:
            sources.append({'id':f"{f['id']}-{variant}",'supplierId':f['supplierId'],'layout':f['layout'],'variant':variant,'path':'input/'+pdf.name,'mimeType':'application/pdf','pages':1,'frame':{'width':dims[0],'height':dims[1],'unit':'point','rotation':0},'sha256':sha(pdf.read_bytes()),'byteLength':pdf.stat().st_size,'provenance':{'kind':'synthetic','description':'Project-authored invented supplier invoice'+(' rendered as an image-only controlled scan proxy' if variant=='scan' else ' with native PDF text'),'license':'Project-authored evaluation fixture; may be redistributed','originalFilename':pdf.name}})
manifest={'version':'heldout-suppliers-v1','baselineCode':'3f41c68b149a97be7aee3ad4f5a98de9473bb258','scope':'Two newly authored suppliers and layouts, frozen before actual parser calls; not an independent production benchmark','generation':'generate.py reads authoring/facts.json only; fixed PDF metadata and deterministic scan transformation','sources':sources,'runtimeContextFile':'runtime-contexts.json','evaluationOnlyFile':'evaluation/expected-outcomes.json','evaluationAccess':'Not a runtime parser input','providerCallsByGenerator':0}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
contexts={f['supplierId']:{'supplier':{'supplierId':f['supplierId'],'legalName':f['supplier']},'coding':{'account':'5000','store':'heldout-test-store','department':None,'project':None,'treatment':'expense'}} for f in facts['invoices']}
(out/'runtime-contexts.json').write_text(json.dumps(contexts,indent=2)+'\n')
print(json.dumps({'originals':len(sources),'totalBytes':sum(s['byteLength'] for s in sources),'providerCalls':0}))
