import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.request import Request, build_opener, HTTPCookieProcessor
from urllib.error import HTTPError
from http.cookiejar import CookieJar
from concurrent.futures import ThreadPoolExecutor

from server import ERP, BusinessError, make_server, scaled


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.erp = ERP(self.temp.name, demo=True)
        with self.erp.connection() as db:
            self.admin = dict(db.execute('SELECT id,username,name,role FROM users WHERE username="admin"').fetchone())

    def tearDown(self):
        self.temp.cleanup()

    def act(self, action, **data):
        return self.erp.action(self.admin,action,data)

    def state(self):
        return self.erp.state(self.admin)

    def stock(self, mid):
        return sum(l['qty'] for l in self.state()['lots'] if l['material_id']==mid)

    def work(self, qty='10', **extra):
        self.act('work',product_id=3,qty=qty,due='2026-12-01',**extra)
        return self.state()['workorders'][0]['id']

    def test_manufacturing_to_sale_and_payment(self):
        self.act('sale',product_id=3,partner_id=1,qty='100',price='48',due='2026-12-01')
        sale=self.state()['sales'][0]
        wid=self.work('100',sale_id=sale['id'])
        before=self.stock(1)
        self.act('issue',id=wid)
        self.assertEqual(self.stock(1),before-125000)
        with self.assertRaises(BusinessError):
            self.act('complete',id=wid,batch='FG-NEW',processing_cost='200')
        for _ in range(4):
            self.act('advance',id=wid)
        self.act('complete',id=wid,batch='FG-NEW',processing_cost='200')
        w=self.state()['workorders'][0]
        self.assertEqual(w['status'],'已完工')
        self.assertEqual(w['material_cost'],365000)
        self.assertEqual(w['processing_cost'],20000)
        self.act('ship',id=sale['id'])
        self.assertEqual(self.stock(3),80000)
        self.act('payment',kind='收款',reference=sale['number'],amount='4800')
        self.assertEqual(self.state()['payments'][0]['amount'],480000)
        with self.assertRaises(BusinessError):
            self.act('payment',kind='收款',reference=sale['number'],amount='0.01')
        with self.assertRaises(BusinessError):
            self.act('ship',id=sale['id'])

    def test_trade_purchase_direct_to_sale_fifo(self):
        for batch,qty,price in [('TRADE-A','8','30'),('TRADE-B','12','35')]:
            self.act('purchase',material_id=5,partner_id=3,qty=qty,price=price)
            p=self.state()['purchases'][0]
            self.act('receive',id=p['id'],batch=batch)
        self.act('sale',product_id=5,partner_id=1,qty='10',price='68',due='2026-12-01')
        sale=self.state()['sales'][0]
        self.act('ship',id=sale['id'])
        moves=[m for m in self.state()['movements'] if m['reference']==sale['number']]
        self.assertEqual({m['batch']:m['qty'] for m in moves},{'TRADE-A':-8000,'TRADE-B':-2000})
        self.assertEqual(sum(m['amount'] for m in moves),-31000)
        self.assertEqual(self.stock(5),10000)
        with self.assertRaises(BusinessError):
            self.act('work',product_id=5,qty='1',due='2026-12-01')

    def test_insufficient_material_rolls_back_all_stock(self):
        # Steel/fabric is sufficient; second material is not. First deduction must roll back.
        self.act('bom',product_id=3,material_id=2,qty='1000')
        wid=self.work('10')
        stock_before=self.stock(1)
        moves_before=len(self.state()['movements'])
        with self.assertRaises(BusinessError):
            self.act('issue',id=wid)
        self.assertEqual(self.stock(1),stock_before)
        self.assertEqual(len(self.state()['movements']),moves_before)
        self.assertEqual(self.state()['workorders'][0]['status'],'待领料')

    def test_bom_frozen_at_work_creation(self):
        wid=self.work()
        self.act('bom',product_id=3,material_id=1,qty='9')
        req=[r for r in self.state()['requirements'] if r['work_id']==wid and r['material_id']==1][0]
        self.assertEqual(req['qty'],12500)

    def test_duplicate_receipt_and_batch_rejected(self):
        self.act('purchase',material_id=5,partner_id=3,qty='10',price='20')
        p=self.state()['purchases'][0]
        self.act('receive',id=p['id'],batch='T-1')
        with self.assertRaises(BusinessError):
            self.act('receive',id=p['id'],batch='T-2')
        with self.assertRaises(BusinessError):
            self.act('opening',material_id=5,batch='T-1',qty='10',price='20')
        self.assertEqual(self.stock(5),10000)

    def test_concurrent_ship_cannot_oversell(self):
        self.act('opening',material_id=5,batch='T-1',qty='10',price='20')
        for _ in range(2):
            self.act('sale',product_id=5,partner_id=1,qty='10',price='30',due='2026-12-01')
        ids=[r['id'] for r in self.state()['sales'] if r['product_id']==5]
        def ship(key):
            try:
                self.act('ship',id=key)
                return True
            except BusinessError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sum(pool.map(ship,ids)),1)
        self.assertEqual(self.stock(5),0)

    def test_permissions_and_password_change(self):
        with self.erp.connection() as db:
            warehouse=dict(db.execute('SELECT id,username,name,role FROM users WHERE username="warehouse"').fetchone())
        with self.assertRaises(BusinessError):
            self.erp.action(warehouse,'material',{'code':'X','name':'X','kind':'成品','unit':'件'})
        creds=Path(self.temp.name,'initial-accounts.txt').read_text()
        pw=[l.split(': ',1)[1] for l in creds.splitlines() if l.startswith('admin:')][0]
        token=self.erp.login('admin',pw)
        self.assertTrue(self.erp.user(token))
        self.act('password',old_password=pw,new_password='changed-password-1234')
        self.assertIsNone(self.erp.user(token))
        self.assertTrue(self.erp.login('admin','changed-password-1234'))

    def test_decimal_validation_and_order_planning(self):
        for n in ['NaN','Infinity','-1','0','0.0001']:
            with self.assertRaises(BusinessError):
                scaled(n,positive=True)
        self.assertEqual(scaled('1.125'),1125)
        sale=self.state()['sales'][0]
        with self.assertRaises(BusinessError):
            self.act('work',product_id=sale['product_id'],sale_id=sale['id'],qty='10000',due='2026-12-01')
        self.assertFalse(self.state()['workorders'])

    def test_empty_database_and_restart_preserves_data(self):
        with tempfile.TemporaryDirectory() as d:
            e=ERP(d)
            self.assertEqual(e.state(self.admin)['materials'],[])
        before=self.state()['lots']
        again=ERP(self.temp.name,demo=True)
        self.assertEqual(before,again.state(self.admin)['lots'])


    def test_backup_is_consistent_and_restorable(self):
        from backup import backup
        target=Path(self.temp.name)/'backup.sqlite3'
        backup(self.erp.dbpath,target)
        with sqlite3.connect(target) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM materials').fetchone()[0],5)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],0)
        with self.assertRaises(FileExistsError):
            backup(self.erp.dbpath,target)
        with tempfile.TemporaryDirectory() as restored_dir:
            import shutil
            shutil.copyfile(target,Path(restored_dir)/'erp.sqlite3')
            restored=ERP(restored_dir)
            self.assertEqual(len(restored.state(self.admin)['materials']),5)


    def test_local_password_recovery_revokes_only_target_sessions(self):
        from manage_accounts import reset_password
        creds=Path(self.temp.name,'initial-accounts.txt').read_text()
        passwords=dict(line.split(': ',1) for line in creds.splitlines() if ': ' in line)
        old=self.erp.login('admin',passwords['admin'])
        other=self.erp.login('sales',passwords['sales'])
        reset_password(self.erp.dbpath,'admin','new-secure-password-123')
        self.assertIsNone(self.erp.user(old))
        self.assertIsNotNone(self.erp.user(other))
        with self.assertRaises(BusinessError):
            self.erp.login('admin',passwords['admin'])
        self.assertTrue(self.erp.login('admin','new-secure-password-123'))
        with self.assertRaises(BusinessError):
            reset_password(self.erp.dbpath,'admin','short')
        with self.assertRaises(sqlite3.OperationalError):
            reset_password(Path(self.temp.name)/'missing.sqlite3','admin','new-secure-password-123')
        self.assertFalse(Path(self.temp.name,'missing.sqlite3').exists())


    def test_invoices_independent_of_inventory_and_payments(self):
        before=self.state()
        self.act('invoice',number='INV-001',kind='销售发票',partner_id=1,issued_on='2026-11-01',amount='113',tax='13')
        invoice=self.state()['invoices'][0]
        self.assertEqual(invoice['amount'],11300)
        self.assertEqual(invoice['tax'],1300)
        self.assertIsNone(invoice['sale_id'])
        self.assertEqual(before['lots'],self.state()['lots'])
        self.assertEqual(before['payments'],self.state()['payments'])
        self.assertEqual(before['sales'],self.state()['sales'])
        with self.assertRaises(sqlite3.IntegrityError):
            self.act('invoice',number='INV-001',kind='销售发票',partner_id=1,issued_on='2026-11-01',amount='1',tax='0')
        for data in [dict(amount='10',tax='11'),dict(amount='10',tax='1',partner_id=3),dict(amount='10',tax='1',issued_on='bad')]:
            values=dict(number='BAD',kind='销售发票',partner_id=1,issued_on='2026-11-01',amount='10',tax='0')
            values.update(data)
            with self.assertRaises(BusinessError):
                self.act('invoice',**values)
        self.assertEqual(len(self.state()['invoices']),1)

    def test_linked_invoice_cap_and_void_preserves_history(self):
        sale=self.state()['sales'][0]
        total=sale['qty']*sale['price']//1000/100
        data=dict(kind='销售发票',partner_id=sale['partner_id'],order_id=sale['id'],issued_on='2026-11-01',amount=str(total),tax='0')
        self.act('invoice',number='LINK-1',**data)
        with self.assertRaises(BusinessError):
            self.act('invoice',number='LINK-2',**data)
        original=self.state()['invoices'][0]
        self.act('void_invoice',id=original['id'])
        self.act('invoice',number='LINK-2',**data)
        invoices=self.state()['invoices']
        self.assertEqual(len(invoices),2)
        self.assertEqual([r['status'] for r in invoices],['有效','作废'])
        with self.assertRaises(BusinessError):
            self.act('void_invoice',id=original['id'])
        self.assertEqual(self.state()['payments'],[])

    def test_purchase_invoice_order_and_permissions(self):
        self.act('purchase',partner_id=3,material_id=1,qty='2',price='18')
        order=self.state()['purchases'][0]
        self.act('invoice',number='BUY-1',kind='采购发票',partner_id=3,order_id=order['id'],issued_on='2026-11-01',amount='36',tax='2')
        self.assertEqual(self.state()['invoices'][0]['purchase_id'],order['id'])
        with self.assertRaises(BusinessError):
            self.act('invoice',number='BUY-2',kind='采购发票',partner_id=4,order_id=order['id'],issued_on='2026-11-01',amount='1',tax='0')
        with self.erp.connection() as db:
            user=dict(db.execute("SELECT id,username,name,role FROM users WHERE username='warehouse'").fetchone())
        with self.assertRaises(BusinessError):
            self.erp.action(user,'invoice',{})

    def test_shipment_and_stock_commit_together(self):
        sale=self.state()['sales'][0]
        with self.assertRaises(BusinessError):
            self.act('ship',id=sale['id'])
        self.assertEqual(self.state()['shipments'],[])
        self.act('sale',partner_id=1,product_id=3,qty='10',price='48',due='2026-12-01')
        sale=self.state()['sales'][0]
        self.act('ship',id=sale['id'],shipped_on='2026-11-01',receiver='张经理',address='测试收货地址',carrier='测试物流',tracking='TEST-001',note='测试出货')
        shipment=self.state()['shipments'][0]
        self.assertEqual(shipment['sale_id'],sale['id'])
        self.assertEqual(shipment['tracking'],'TEST-001')
        self.assertEqual(shipment['shipped_on'],'2026-11-01')
        self.assertEqual(self.stock(3),70000)
        with self.assertRaises(BusinessError):
            self.act('ship',id=sale['id'])
        self.assertEqual(len(self.state()['shipments']),1)

    def test_legacy_upgrade_backup_and_shipment_backfill(self):
        self.act('sale',partner_id=1,product_id=3,qty='10',price='48',due='2026-12-01')
        sale=self.state()['sales'][0]
        self.act('ship',id=sale['id'])
        before=self.state()
        with self.erp.connection() as db:
            db.executescript('DROP TABLE shipments; DROP TABLE invoices; PRAGMA user_version=0;')
        upgraded=ERP(self.temp.name)
        after=upgraded.state(self.admin)
        self.assertEqual(before['lots'],after['lots'])
        self.assertEqual(before['movements'],after['movements'])
        self.assertEqual(before['sales'],after['sales'])
        self.assertEqual(len(after['shipments']),1)
        self.assertIn('历史',after['shipments'][0]['note'])
        backups=list(Path(self.temp.name,'backups').glob('*.sqlite3'))
        self.assertEqual(len(backups),1)
        with sqlite3.connect(backups[0]) as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='shipments'").fetchone())
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        ERP(self.temp.name)
        self.assertEqual(len(list(Path(self.temp.name,'backups').glob('*.sqlite3'))),1)
        self.assertEqual(len(upgraded.state(self.admin)['shipments']),1)


class DesktopLauncherTests(unittest.TestCase):
    def test_demo_is_separate_and_handles_busy_port(self):
        from try_erp import prepare_demo
        with tempfile.TemporaryDirectory() as directory:
            demo=Path(directory)/'desktop'
            server,first=prepare_demo(demo,port=0)
            try:
                self.assertTrue(first)
                self.assertTrue((demo/'demo-mode').exists())
                with sqlite3.connect(demo/'erp.sqlite3') as db:
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM materials').fetchone()[0],5)
                password_file=(demo/'initial-accounts.txt').read_bytes()
                second,first_again=prepare_demo(demo,port=server.server_port)
                try:
                    self.assertFalse(first_again)
                    self.assertNotEqual(second.server_port,server.server_port)
                    self.assertEqual(password_file,(demo/'initial-accounts.txt').read_bytes())
                    self.assertEqual(second.server_address[0],'127.0.0.1')
                finally:
                    second.server_close()
            finally:
                server.server_close()


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.erp=ERP(cls.temp.name,True)
        cls.server=make_server(cls.erp,port=0)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}'
        cls.opener=build_opener(HTTPCookieProcessor(CookieJar()))

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def test_http_auth_csrf_and_assets(self):
        with self.assertRaises(HTTPError) as err:
            self.opener.open(self.url+'/api/state')
        self.assertEqual(err.exception.code,401)
        password=[l.split(': ',1)[1] for l in Path(self.temp.name,'initial-accounts.txt').read_text().splitlines() if l.startswith('admin:')][0]
        def post(path,data,headers=None):
            return self.opener.open(Request(self.url+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json',**(headers or {})}))
        response=post('/api/login',{'username':'admin','password':password})
        self.assertIn('HttpOnly',response.headers['Set-Cookie'])
        self.assertTrue(json.load(self.opener.open(self.url+'/api/state'))['materials'])
        with self.assertRaises(HTTPError) as err:
            post('/api/actions/ship',{'id':1},{'Origin':'https://evil.example'})
        self.assertEqual(err.exception.code,403)
        for path in ['/','/help','/app.js','/style.css','/manifest.webmanifest','/icon.svg']:
            self.assertEqual(self.opener.open(self.url+path).status,200)
        manifest=json.load(self.opener.open(self.url+'/manifest.webmanifest'))
        self.assertEqual(manifest['start_url'],'/')
        with self.assertRaises(HTTPError):
            self.opener.open(self.url+'/initial-accounts.txt')
        post('/api/logout',{})
        with self.assertRaises(HTTPError):
            self.opener.open(self.url+'/api/state')

    def test_admin_backup_download_and_authorization(self):
        passwords=dict(line.split(': ',1) for line in Path(self.temp.name,'initial-accounts.txt').read_text().splitlines() if ': ' in line)
        for username,expected in [('warehouse',403),('admin',200)]:
            client=build_opener(HTTPCookieProcessor(CookieJar()))
            def post(path,data):
                return client.open(Request(self.url+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'}))
            post('/api/login',{'username':username,'password':passwords[username]})
            if expected==403:
                with self.assertRaises(HTTPError) as error:
                    post('/api/backup',{})
                self.assertEqual(error.exception.code,403)
            else:
                response=post('/api/backup',{})
                self.assertIn('attachment',response.headers['Content-Disposition'])
                filename=Path(self.temp.name)/'downloaded.sqlite3'
                filename.write_bytes(response.read())
                with sqlite3.connect(filename) as db:
                    self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],0)
                    self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='invoices'").fetchone())

if __name__=='__main__':
    unittest.main()
