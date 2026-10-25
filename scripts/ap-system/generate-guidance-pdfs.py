"""Reproducible, visibly synthetic one-page invoices; reportlab required."""
from reportlab.pdfgen import canvas
from pathlib import Path
root = Path(__file__).resolve().parents[2] / 'fixtures/ap-system/guidance-pdfs'
root.mkdir(parents=True, exist_ok=True)
for name, number, category, description, amount in [
    ('cleaning-b', 'CLEAN-B-20261025', 'routine_cleaning', 'Routine store cleaning service', 8500),
    ('renovation-c', 'RENOV-C-20261026', 'capital_renovation', 'Capital renovation of store interior', 250000),
]:
    c = canvas.Canvas(str(root / (name+'.pdf')), pagesize=(612,792), invariant=1)
    c.setTitle('Synthetic '+number)
    c.setFont('Helvetica-Bold',18);c.drawString(48,735,'SYNTHETIC DEMONSTRATION')
    c.setFont('Helvetica',11);c.drawString(48,711,'Test invoice only. No payment is due. All identities are synthetic.')
    lines = ['Supplier: CleanCo Demo', 'Supplier ID: hyphenate-demo-cleaning', 'Invoice number: '+number,
             'Invoice date: '+('2026-10-25' if name=='cleaning-b' else '2026-10-26'),
             'Service category: '+category, 'Location: sf-hayes-valley', 'Currency: USD',
             'Description: '+description, 'Total cents: '+str(amount)]
    y=665
    for line in lines:c.drawString(48,y,line);y-=31
    c.setFont('Helvetica-Bold',16);c.drawString(48,y-20,'Total: USD '+format(amount/100,',.2f'))
    c.setFont('Helvetica',10);c.drawString(48,70,'Uploaded bytes are retained and hashed. Independent review remains required.')
    c.drawString(48,52,'CC0 synthetic fixture | 1 / 1');c.save()
