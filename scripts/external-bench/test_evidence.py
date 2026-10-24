import io
import json
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path
from evidence import connect, handle, aging_rules, fee_matches
from prepare import unpack, build_database


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root/'public.sqlite'
        db = sqlite3.connect(self.path)
        db.executescript('CREATE TABLE documents(path TEXT,content TEXT); CREATE TABLE table_catalog(name TEXT,path TEXT,sheet TEXT,columns_json TEXT,row_count INTEGER); CREATE TABLE payments(amount REAL); INSERT INTO payments VALUES (12.50),(7.50);')
        db.execute('INSERT INTO documents VALUES (?,?)', ('invoice.txt', 'Public invoice evidence'))
        db.commit()
        db.close()
        (self.root/'gold.json').write_text('SECRET ANSWER')
        self.db = connect(self.path)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_aggregates_public_evidence(self):
        result = handle(self.db, {'operation':'query','sql':'SELECT SUM(amount) AS total FROM payments'})
        self.assertEqual(result['rows'], [{'total':20}])

    def test_denies_writes_attach_and_extension_access(self):
        for sql in ['DELETE FROM payments', "ATTACH DATABASE '../gold.json' AS answers", 'PRAGMA database_list', "SELECT load_extension('/tmp/nope')", "SELECT readfile('../gold.json')"]:
            with self.subTest(sql=sql), self.assertRaises(sqlite3.DatabaseError):
                handle(self.db, {'operation':'query','sql':sql})

    def test_document_lookup_is_not_a_filesystem_reader(self):
        with self.assertRaises(ValueError):
            handle(self.db, {'operation':'read','path':'../gold.json'})
        self.assertNotIn('SECRET', json.dumps(handle(self.db, {'operation':'list'})))

    def test_large_worksheet_text_can_be_listed_and_paginated(self):
        content='Ledger row\n' * 120_000
        db=sqlite3.connect(self.path)
        db.execute('INSERT INTO documents VALUES (?,?)',('journal.xlsx',content));db.commit();db.close()
        listing=handle(self.db,{'operation':'list'})
        self.assertEqual(next(d['characters'] for d in listing['documents'] if d['path']=='journal.xlsx'),len(content))
        page=handle(self.db,{'operation':'read','path':'journal.xlsx','offset':1_100_000,'length':100})
        self.assertEqual(page['text'],content[1_100_000:1_100_100])
        self.assertEqual(page['nextOffset'],1_100_100)

    def test_query_caps_output_and_flags_truncation(self):
        result = handle(self.db, {'operation':'query','sql':'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500) SELECT x FROM n'})
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['rows']),200)

    def test_archive_rejects_traversal_and_links(self):
        for name, kind in [('../escape',tarfile.REGTYPE), ('link',tarfile.SYMTYPE)]:
            buffer=io.BytesIO()
            with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
                entry=tarfile.TarInfo(name); entry.type=kind
                archive.addfile(entry)
            with self.assertRaises(ValueError): unpack(buffer.getvalue(),self.root/'unpacked')

    def test_rules_do_not_read_answers_and_change_with_source_values(self):
        db=sqlite3.connect(self.path)
        fee={'card_scheme':'GlobalCard','is_credit':True,'fixed_amount':0.1,'rate':20}
        db.execute('INSERT INTO documents VALUES (?,?)',('fees.json',json.dumps([fee])));db.commit()
        self.assertEqual(handle(self.db,{'operation':'rules','taskId':'dabstep-1273'})['answer'],'0.120000')
        fee['rate']=40
        db.execute('UPDATE documents SET content=? WHERE path=?',(json.dumps([fee]),'fees.json'));db.commit();db.close()
        self.assertEqual(handle(self.db,{'operation':'rules','taskId':'dabstep-1273'})['answer'],'0.140000')
        self.assertEqual(handle(self.db,{'operation':'rules','taskId':'unknown'})['status'],'abstained')

    def test_aging_recomputes_dates_and_ignores_wrong_supplied_bucket(self):
        db=sqlite3.connect(self.path)
        db.execute('CREATE TABLE invoices(_row INTEGER,c1,c2,c3)')
        db.executemany('INSERT INTO invoices VALUES(?,?,?,?)',[(1,'Due Date','Outstanding','Bucket'),(2,'2024-11-02',50,'1-30'),(3,'2025-01-02',50,'>90')])
        db.execute('INSERT INTO table_catalog VALUES(?,?,?,?,?)',('invoices','workpaper_ar_aging_2024_12_31.xlsx','Invoice Detail','[]',3));db.commit();db.close()
        answer=aging_rules(self.db)
        self.assertIn('Current: 50.00%',answer)
        self.assertIn('31-60: 50.00%',answer)
        self.assertIn('1-30: 0.00%',answer)

    def test_xlsx_conversion_keeps_rows_zero_and_formulas(self):
        import openpyxl
        source=self.root/'sample.xlsx'
        workbook=openpyxl.Workbook(); sheet=workbook.active
        sheet.append(['Title']);sheet.append(['Amount','Formula']);sheet.append([0,'=1+2']);workbook.save(source)
        converted=self.root/'converted.sqlite'
        build_database({'sample.xlsx':source},converted)
        db=connect(converted)
        self.assertEqual(db.execute('SELECT c1 FROM t001 WHERE _row=3').fetchone()[0],0)
        self.assertIn('FORMULA B3: =1+2',db.execute('SELECT content FROM documents').fetchone()[0])
        db.close()


if __name__=='__main__': unittest.main()
