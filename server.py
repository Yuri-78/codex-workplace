"""Small manufacturer ERP. Python 3.12+, no third-party runtime dependencies."""
from __future__ import annotations
import argparse
import base64
import binascii
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import tempfile
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
BUSINESS_TZ = timezone(timedelta(hours=8))
SCHEMA = '''
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS materials(id INTEGER PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('原材料','成品','贸易商品')),unit TEXT NOT NULL,min_qty INTEGER NOT NULL DEFAULT 0,price INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS partners(id INTEGER PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('客户','供应商')),contact TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS bom(product_id INTEGER REFERENCES materials(id),material_id INTEGER REFERENCES materials(id),qty INTEGER NOT NULL CHECK(qty>0),PRIMARY KEY(product_id,material_id),CHECK(product_id<>material_id));
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY,number TEXT UNIQUE NOT NULL,partner_id INTEGER NOT NULL REFERENCES partners(id),product_id INTEGER NOT NULL REFERENCES materials(id),qty INTEGER NOT NULL CHECK(qty>0),price INTEGER NOT NULL,due TEXT NOT NULL,status TEXT NOT NULL DEFAULT '待发货',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY,number TEXT UNIQUE NOT NULL,partner_id INTEGER NOT NULL REFERENCES partners(id),material_id INTEGER NOT NULL REFERENCES materials(id),qty INTEGER NOT NULL CHECK(qty>0),price INTEGER NOT NULL,status TEXT NOT NULL DEFAULT '待收货',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workorders(id INTEGER PRIMARY KEY,number TEXT UNIQUE NOT NULL,sale_id INTEGER REFERENCES sales(id),product_id INTEGER NOT NULL REFERENCES materials(id),qty INTEGER NOT NULL CHECK(qty>0),due TEXT NOT NULL,status TEXT NOT NULL DEFAULT '待领料',step INTEGER NOT NULL DEFAULT 0,steps TEXT NOT NULL,material_cost INTEGER NOT NULL DEFAULT 0,processing_cost INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requirements(work_id INTEGER REFERENCES workorders(id),material_id INTEGER REFERENCES materials(id),qty INTEGER NOT NULL CHECK(qty>0),PRIMARY KEY(work_id,material_id));
CREATE TABLE IF NOT EXISTS lots(id INTEGER PRIMARY KEY,material_id INTEGER NOT NULL REFERENCES materials(id),batch TEXT NOT NULL,qty INTEGER NOT NULL CHECK(qty>=0),unit_cost INTEGER NOT NULL CHECK(unit_cost>=0),source TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(material_id,batch));
CREATE TABLE IF NOT EXISTS movements(id INTEGER PRIMARY KEY,material_id INTEGER NOT NULL REFERENCES materials(id),batch TEXT NOT NULL,qty INTEGER NOT NULL,amount INTEGER NOT NULL,kind TEXT NOT NULL,reference TEXT NOT NULL,actor TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,reference TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('收款','付款')),reference TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),note TEXT NOT NULL,actor TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shipments(id INTEGER PRIMARY KEY,number TEXT UNIQUE NOT NULL,sale_id INTEGER UNIQUE NOT NULL REFERENCES sales(id),shipped_on TEXT NOT NULL,receiver TEXT NOT NULL,address TEXT NOT NULL,carrier TEXT NOT NULL,tracking TEXT NOT NULL,note TEXT NOT NULL,actor TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY,number TEXT UNIQUE NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('销售发票','采购发票')),partner_id INTEGER NOT NULL REFERENCES partners(id),sale_id INTEGER REFERENCES sales(id),purchase_id INTEGER REFERENCES purchases(id),issued_on TEXT NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),tax INTEGER NOT NULL CHECK(tax>=0 AND tax<=amount),status TEXT NOT NULL DEFAULT '有效' CHECK(status IN ('有效','作废')),note TEXT NOT NULL,actor TEXT NOT NULL,created TEXT NOT NULL,CHECK((kind='销售发票' AND purchase_id IS NULL) OR (kind='采购发票' AND sale_id IS NULL)));
CREATE INDEX IF NOT EXISTS invoices_sale ON invoices(sale_id,status);
CREATE INDEX IF NOT EXISTS invoices_purchase ON invoices(purchase_id,status);
CREATE INDEX IF NOT EXISTS movements_reference ON movements(reference);
CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY,number TEXT UNIQUE NOT NULL,purchase_id INTEGER UNIQUE NOT NULL REFERENCES purchases(id),received_on TEXT NOT NULL,actor TEXT NOT NULL,created TEXT NOT NULL,note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS invoice_shipments(invoice_id INTEGER NOT NULL REFERENCES invoices(id),shipment_id INTEGER NOT NULL REFERENCES shipments(id),PRIMARY KEY(invoice_id,shipment_id));
CREATE TABLE IF NOT EXISTS attachments(id INTEGER PRIMARY KEY,shipment_id INTEGER REFERENCES shipments(id),receipt_id INTEGER REFERENCES receipts(id),filename TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>0 AND size<=8388608),data BLOB NOT NULL,actor TEXT NOT NULL,created TEXT NOT NULL,CHECK((shipment_id IS NOT NULL AND receipt_id IS NULL) OR (shipment_id IS NULL AND receipt_id IS NOT NULL)));


'''

class BusinessError(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def scaled(value, scale=1000, positive=False):
    try:
        d = Decimal(str(value))
        if not d.is_finite() or d < 0 or (positive and d <= 0) or d > Decimal('100000000'):
            raise ValueError
        result = d * scale
        if result != result.to_integral_value():
            raise BusinessError('数量最多 3 位小数，金额最多 2 位小数')
        return int(result)
    except (InvalidOperation, ValueError, TypeError):
        raise BusinessError('请输入有效的非负数字')


def cost(qty, price):
    return int((Decimal(qty) * price / 1000).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def text(data, name, default=None):
    value = str(data.get(name, default) or '').strip()
    if not value or len(value) > 160:
        raise BusinessError(f'{name} 不能为空且不能超过 160 个字符')
    return value


def ident(data, name):
    try:
        value = int(data[name])
        if value <= 0:
            raise ValueError
        return value
    except (KeyError, ValueError, TypeError):
        raise BusinessError(f'请选择有效的 {name}')


def due_date(data, key='due'):
    value = text(data, key)
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise BusinessError('日期格式应为 YYYY-MM-DD')


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


class ERP:
    def __init__(self, directory, demo=False):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.dbpath = self.directory / 'erp.sqlite3'
        # Older account books get a consistent local backup before this schema upgrade.
        # This is upgrade protection, not an off-device disaster-recovery backup.
        with self.connection() as check:
            version = check.execute('PRAGMA user_version').fetchone()[0]
            existing = check.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
        if version > 2:
            raise BusinessError('数据库版本高于当前程序，请勿使用旧程序打开')
        if existing and version < 2:
            from backup import backup
            folder = self.directory / 'backups'
            folder.mkdir(exist_ok=True, mode=0o700)
            backup(self.dbpath, folder / f'pre-upgrade-{secrets.token_hex(8)}.sqlite3')
        with self.connection() as db:
            db.executescript(SCHEMA)
            db.execute('PRAGMA journal_mode=WAL')
            if not db.execute('SELECT 1 FROM users').fetchone():
                credentials = []
                for username, name, role in [('admin','管理员','管理'),('sales','销售与采购','业务'),('warehouse','仓库管理员','仓库'),('production','生产负责人','生产')]:
                    password = secrets.token_urlsafe(12)
                    salt = secrets.token_hex(16)
                    db.execute('INSERT INTO users(username,name,role,salt,password) VALUES(?,?,?,?,?)', (username,name,role,salt,password_hash(password,salt)))
                    credentials.append(f'{username}: {password}')
                credential_path = self.directory / 'initial-accounts.txt'
                fd = os.open(credential_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as f:
                    f.write('首次登录账号（请在登录后更改密码）\n' + '\n'.join(credentials) + '\n')
            if demo and not db.execute('SELECT 1 FROM materials').fetchone():
                self.seed(db)
            self.backfill_shipments(db)
            for order in db.execute("SELECT p.* FROM purchases p LEFT JOIN receipts r ON r.purchase_id=p.id WHERE p.status='已收货' AND r.id IS NULL").fetchall():
                stamp=db.execute("SELECT MIN(created) FROM movements WHERE reference=? AND kind='采购入库'",(order['number'],)).fetchone()[0]
                day=datetime.fromisoformat(stamp).astimezone(BUSINESS_TZ).date().isoformat() if stamp else ''
                db.execute('INSERT INTO receipts(number,purchase_id,received_on,actor,created,note) VALUES(?,?,?,?,?,?)',
                           (self.number('RC'),order['id'],day,'历史导入',stamp or now(),'历史收货记录补录'))
            invoice_columns = {row['name'] for row in db.execute('PRAGMA table_info(invoices)')}
            for column in ('planned_on','part_name'):
                if column not in invoice_columns:
                    db.execute(f"ALTER TABLE invoices ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
            payment_columns = {row['name'] for row in db.execute('PRAGMA table_info(payments)')}
            if 'invoice_id' not in payment_columns:
                db.execute('ALTER TABLE payments ADD COLUMN invoice_id INTEGER REFERENCES invoices(id)')
            if 'paid_on' not in payment_columns:
                db.execute("ALTER TABLE payments ADD COLUMN paid_on TEXT NOT NULL DEFAULT ''")
            db.execute('CREATE INDEX IF NOT EXISTS payments_invoice ON payments(invoice_id)')
            db.execute("UPDATE invoices SET part_name=COALESCE((SELECT m.name FROM sales o JOIN materials m ON m.id=o.product_id WHERE o.id=invoices.sale_id),(SELECT m.name FROM purchases o JOIN materials m ON m.id=o.material_id WHERE o.id=invoices.purchase_id),'') WHERE part_name=''")
            db.execute('PRAGMA user_version=2')
        os.chmod(self.dbpath, 0o600)
        from backup import MonthlyBackup
        self.monthly_backup = MonthlyBackup(self.dbpath, self.directory / 'backups' / 'monthly')

    def backfill_shipments(self, db):
        # Historical sales already deducted stock. Create documentary records only.
        sales = db.execute("SELECT s.* FROM sales s LEFT JOIN shipments h ON h.sale_id=s.id WHERE s.status='已发货' AND h.id IS NULL").fetchall()
        for sale in sales:
            movement = db.execute("SELECT MIN(created) FROM movements WHERE reference=? AND kind='销售出库'", (sale['number'],)).fetchone()[0]
            shipped_on = datetime.fromisoformat(movement).astimezone(BUSINESS_TZ).date().isoformat() if movement else ''
            db.execute('INSERT INTO shipments(number,sale_id,shipped_on,receiver,address,carrier,tracking,note,actor,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (self.number('SH'),sale['id'],shipped_on,'','','','','历史出货记录补录，物流资料未知','历史导入',movement or now()))

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.dbpath, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def rows(db, query, params=()):
        return [dict(r) for r in db.execute(query, params)]

    @staticmethod
    def one(db, table, key):
        allowed = {'materials','partners','sales','purchases','workorders','users','invoices','shipments','receipts'}
        if table not in allowed:
            raise BusinessError('无效的数据表')
        r = db.execute(f'SELECT * FROM {table} WHERE id=?', (key,)).fetchone()
        if not r:
            raise BusinessError('记录不存在')
        return r

    @staticmethod
    def number(prefix):
        return f'{prefix}-{datetime.now(BUSINESS_TZ).strftime("%y%m%d")}-{secrets.token_hex(3).upper()}'

    @staticmethod
    def audit(db, actor, action, reference):
        db.execute('INSERT INTO audit(actor,action,reference,created) VALUES(?,?,?,?)', (actor,action,reference,now()))

    def add_lot(self, db, mid, batch, qty, price, kind, ref, actor):
        if db.execute('SELECT 1 FROM lots WHERE material_id=? AND batch=?', (mid,batch)).fetchone():
            raise BusinessError('该物料批次已存在，请使用新批号')
        db.execute('INSERT INTO lots(material_id,batch,qty,unit_cost,source,created) VALUES(?,?,?,?,?,?)', (mid,batch,qty,price,ref,now()))
        db.execute('INSERT INTO movements(material_id,batch,qty,amount,kind,reference,actor,created) VALUES(?,?,?,?,?,?,?,?)', (mid,batch,qty,cost(qty,price),kind,ref,actor,now()))

    def consume(self, db, mid, qty, kind, ref, actor):
        lots = db.execute('SELECT * FROM lots WHERE material_id=? AND qty>0 ORDER BY id', (mid,)).fetchall()
        if sum(r['qty'] for r in lots) < qty:
            m = self.one(db,'materials',mid)
            raise BusinessError(f'{m["name"]} 库存不足，需要 {qty/1000:g} {m["unit"]}')
        total = 0
        for lot in lots:
            take = min(qty, lot['qty'])
            amount = cost(take,lot['unit_cost'])
            db.execute('UPDATE lots SET qty=qty-? WHERE id=?', (take,lot['id']))
            db.execute('INSERT INTO movements(material_id,batch,qty,amount,kind,reference,actor,created) VALUES(?,?,?,?,?,?,?,?)', (mid,lot['batch'],-take,-amount,kind,ref,actor,now()))
            total += amount
            qty -= take
            if not qty:
                break
        return total

    def seed(self, db):
        db.executemany('INSERT INTO materials(code,name,kind,unit,min_qty,price) VALUES(?,?,?,?,?,?)', [
            ('RM-001','汽车内饰复合面料','原材料','米',200000,1800),
            ('RM-002','耐温双面背胶','原材料','米',500000,350),
            ('FG-001','汽车内饰隔音垫','成品','件',100000,4800),
            ('FG-002','座椅防护套','成品','件',60000,3200),
            ('TR-001','代理品牌密封条','贸易商品','套',50000,6800)])
        db.executemany('INSERT INTO partners(name,kind,contact) VALUES(?,?,?)', [('华东汽车零部件有限公司','客户','张经理'),('远航汽车配套有限公司','客户','李经理'),('恒达面料有限公司','供应商','王经理'),('精工胶粘材料有限公司','供应商','陈经理')])
        db.executemany('INSERT INTO bom VALUES(?,?,?)', [(3,1,1250),(3,2,4000),(4,1,800),(4,2,2000)])
        self.add_lot(db,1,'DEMO-FABRIC-01',650000,1800,'期初入库','演示期初','系统')
        self.add_lot(db,2,'DEMO-ADHESIVE-01',1800000,350,'期初入库','演示期初','系统')
        self.add_lot(db,3,'DEMO-FG-01',80000,2200,'期初入库','演示期初','系统')
        today = datetime.now(BUSINESS_TZ).date()
        for partner, product, qty, price, days in [(1,3,300000,4800,7),(2,4,200000,3200,12)]:
            db.execute('INSERT INTO sales(number,partner_id,product_id,qty,price,due,created) VALUES(?,?,?,?,?,?,?)', (self.number('SO'),partner,product,qty,price,(today+timedelta(days=days)).isoformat(),now()))

    def login(self, username, password):
        with self.connection() as db:
            r = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
            # A real hash on unknown users avoids a fast username probe.
            salt = r['salt'] if r else '0'*32
            valid = secrets.compare_digest(password_hash(password,salt), r['password'] if r else '0'*128)
            if not r or not valid:
                raise BusinessError('账号或密码不正确')
            token = secrets.token_urlsafe(32)
            db.execute('DELETE FROM sessions WHERE expires<?', (now(),))
            db.execute('INSERT INTO sessions VALUES(?,?,?)', (token,r['id'],(datetime.now(timezone.utc)+timedelta(hours=12)).isoformat(timespec='seconds')))
            return token

    def user(self, token):
        with self.connection() as db:
            r = db.execute('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?', (token,now())).fetchone()
            return dict(r) if r else None

    def state(self, user):
        with self.connection() as db:
            result = {t:self.rows(db,f'SELECT * FROM {t} ORDER BY id DESC') for t in ('materials','partners','sales','purchases','workorders','lots','movements','audit','payments','shipments','invoices','receipts')}
            result['attachments'] = self.rows(db,'SELECT id,shipment_id,receipt_id,filename,mime,size,actor,created FROM attachments ORDER BY id DESC')
            result['invoice_shipments'] = self.rows(db,'SELECT * FROM invoice_shipments')
            result['bom'] = self.rows(db,'SELECT * FROM bom ORDER BY product_id,material_id')
            result['requirements'] = self.rows(db,'SELECT * FROM requirements')
            result['invoices'] = self.rows(db, 'SELECT i.*, COALESCE(SUM(p.amount),0) AS settled_amount, MAX(p.paid_on) AS last_paid_on FROM invoices i LEFT JOIN payments p ON p.invoice_id=i.id GROUP BY i.id ORDER BY i.id DESC')
            if user['role']=='管理':
                result['monthly_backup'] = self.monthly_backup.status()
            result['user'] = user
            result['demo'] = (self.directory / 'demo-mode').exists()
            return result

    def invoice_shipments(self, db, data, partner_id, kind):
        ids=data.get('shipment_ids',[])
        if not isinstance(ids,list) or len(ids)>100:
            raise BusinessError('发货单必须为列表，最多选择 100 张')
        ids=list(dict.fromkeys(ident({'id':key},'id') for key in ids))
        if ids and kind!='销售发票':
            raise BusinessError('只有开出的销售发票可以关联发货单')
        parts=[]
        for key in ids:
            row=db.execute('SELECT o.partner_id,m.name FROM shipments h JOIN sales o ON o.id=h.sale_id JOIN materials m ON m.id=o.product_id WHERE h.id=?',(key,)).fetchone()
            if not row or row['partner_id']!=partner_id:
                raise BusinessError('请选择同一客户的发货单')
            if row['name'] not in parts:
                parts.append(row['name'])
        return ids,', '.join(parts)

    def action(self, user, action, data):
        permissions = {'业务':{'partner','sale','purchase','payment','invoice','void_invoice','invoice_payment','invoice_details'},'仓库':{'opening','receive','ship','attachment'},'生产':{'work','issue','advance','complete'}}
        if action != 'password' and user['role'] != '管理' and action not in permissions.get(user['role'],set()):
            raise BusinessError('当前账号没有此操作权限')
        actor = user['name']
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            ref = ''
            if action == 'material':
                kind = text(data,'kind')
                if kind not in ('原材料','成品','贸易商品'):
                    raise BusinessError('物料类型无效')
                ref = text(data,'code')
                db.execute('INSERT INTO materials(code,name,kind,unit,min_qty,price) VALUES(?,?,?,?,?,?)', (ref,text(data,'name'),kind,text(data,'unit'),scaled(data.get('min_qty',0)),scaled(data.get('price',0),100)))
            elif action == 'partner':
                kind = text(data,'kind')
                if kind not in ('客户','供应商'):
                    raise BusinessError('往来单位类型无效')
                ref = text(data,'name')
                db.execute('INSERT INTO partners(name,kind,contact) VALUES(?,?,?)', (ref,kind,str(data.get('contact',''))[:160]))
            elif action == 'bom':
                pid, mid = ident(data,'product_id'),ident(data,'material_id')
                if self.one(db,'materials',pid)['kind'] != '成品' or self.one(db,'materials',mid)['kind'] != '原材料':
                    raise BusinessError('BOM 必须由成品和原材料组成')
                db.execute('INSERT INTO bom VALUES(?,?,?) ON CONFLICT(product_id,material_id) DO UPDATE SET qty=excluded.qty', (pid,mid,scaled(data.get('qty'),positive=True)))
                ref = f'{pid}/{mid}'
            elif action == 'opening':
                mid = ident(data,'material_id')
                self.one(db,'materials',mid)
                ref = self.number('OPEN')
                self.add_lot(db,mid,text(data,'batch'),scaled(data.get('qty'),positive=True),scaled(data.get('price'),100),'期初入库',ref,actor)
            elif action in ('sale','purchase'):
                is_sale = action == 'sale'
                partner = self.one(db,'partners',ident(data,'partner_id'))
                mid = ident(data,'product_id' if is_sale else 'material_id')
                material = self.one(db,'materials',mid)
                if partner['kind'] != ('客户' if is_sale else '供应商') or material['kind'] not in (('成品','贸易商品') if is_sale else ('原材料','贸易商品')):
                    raise BusinessError('请选择正确的往来单位和物料类型')
                ref = self.number('SO' if is_sale else 'PO')
                values = (ref,partner['id'],mid,scaled(data.get('qty'),positive=True),scaled(data.get('price'),100))
                if is_sale:
                    db.execute('INSERT INTO sales(number,partner_id,product_id,qty,price,due,created) VALUES(?,?,?,?,?,?,?)', values+(due_date(data),now()))
                else:
                    db.execute('INSERT INTO purchases(number,partner_id,material_id,qty,price,created) VALUES(?,?,?,?,?,?)', values+(now(),))
            elif action == 'receive':
                r = self.one(db,'purchases',ident(data,'id'))
                if r['status'] != '待收货':
                    raise BusinessError('该采购单已收货')
                ref = r['number']
                self.add_lot(db,r['material_id'],text(data,'batch'),r['qty'],r['price'],'采购入库',ref,actor)
                db.execute("UPDATE purchases SET status='已收货' WHERE id=?", (r['id'],))
                day=due_date(data,'received_on') if data.get('received_on') else datetime.now(BUSINESS_TZ).date().isoformat()
                db.execute('INSERT INTO receipts(number,purchase_id,received_on,actor,created) VALUES(?,?,?,?,?)',
                           (self.number('RC'),r['id'],day,actor,now()))
            elif action == 'work':
                pid, qty = ident(data,'product_id'),scaled(data.get('qty'),positive=True)
                if self.one(db,'materials',pid)['kind'] != '成品':
                    raise BusinessError('请选择成品')
                sid = int(data.get('sale_id') or 0) or None
                if sid:
                    sale = self.one(db,'sales',sid)
                    if sale['product_id'] != pid or sale['status'] != '待发货':
                        raise BusinessError('销售订单与成品不匹配或已发货')
                    planned = db.execute('SELECT COALESCE(SUM(qty),0) FROM workorders WHERE sale_id=?',(sid,)).fetchone()[0]
                    if planned+qty > sale['qty']:
                        raise BusinessError('关联工单的总数量不能超过订单数量；备货请创建无关联工单')
                bom = db.execute('SELECT * FROM bom WHERE product_id=?',(pid,)).fetchall()
                if not bom:
                    raise BusinessError('请先维护该成品的 BOM')
                steps = [s.strip() for s in str(data.get('steps','模切,缝纫,背胶,检验')).split(',') if s.strip()]
                if not steps or len(steps)>12 or any(len(s)>30 for s in steps):
                    raise BusinessError('工序需为 1–12 项，每项不超过 30 字，使用英文逗号分隔')
                ref = self.number('MO')
                cur = db.execute('INSERT INTO workorders(number,sale_id,product_id,qty,due,steps,created) VALUES(?,?,?,?,?,?,?)', (ref,sid,pid,qty,due_date(data),json.dumps(steps,ensure_ascii=False),now()))
                for line in bom:
                    required = int((Decimal(qty)*line['qty']/1000).to_integral_value(rounding='ROUND_CEILING'))
                    db.execute('INSERT INTO requirements VALUES(?,?,?)', (cur.lastrowid,line['material_id'],required))
            elif action in ('issue','advance','complete'):
                r = self.one(db,'workorders',ident(data,'id'))
                ref = r['number']
                steps = json.loads(r['steps'])
                if action == 'issue':
                    if r['status'] != '待领料':
                        raise BusinessError('只有待领料工单可以领料')
                    total = 0
                    for line in db.execute('SELECT * FROM requirements WHERE work_id=?',(r['id'],)).fetchall():
                        total += self.consume(db,line['material_id'],line['qty'],'生产领料',ref,actor)
                    db.execute("UPDATE workorders SET status='生产中',material_cost=? WHERE id=?", (total,r['id']))
                elif action == 'advance':
                    if r['status'] != '生产中' or r['step'] >= len(steps):
                        raise BusinessError('工单当前不能报工')
                    db.execute('UPDATE workorders SET step=step+1 WHERE id=?',(r['id'],))
                    ref += ' / ' + steps[r['step']]
                else:
                    if r['status'] != '生产中' or r['step'] != len(steps):
                        raise BusinessError('请先完成所有工序和检验，再完工入库')
                    processing = scaled(data.get('processing_cost',0),100)
                    price = int((Decimal(r['material_cost']+processing)*1000/r['qty']).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
                    self.add_lot(db,r['product_id'],text(data,'batch'),r['qty'],price,'完工入库',ref,actor)
                    db.execute("UPDATE workorders SET status='已完工',processing_cost=? WHERE id=?", (processing,r['id']))
            elif action == 'ship':
                r = self.one(db,'sales',ident(data,'id'))
                if r['status'] != '待发货':
                    raise BusinessError('该订单已发货')
                ref = r['number']
                shipped_on = due_date(data, 'shipped_on') if data.get('shipped_on') else datetime.now(BUSINESS_TZ).date().isoformat()
                details = [str(data.get(key,'')).strip() for key in ('receiver','address','carrier','tracking','note')]
                if any(len(value)>160 for value in details):
                    raise BusinessError('出货信息每项最多 160 个字符')
                self.consume(db,r['product_id'],r['qty'],'销售出库',ref,actor)
                db.execute("UPDATE sales SET status='已发货' WHERE id=?",(r['id'],))
                shipment_number = self.number('SH')
                db.execute('INSERT INTO shipments(number,sale_id,shipped_on,receiver,address,carrier,tracking,note,actor,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                           (shipment_number,r['id'],shipped_on,*details,actor,now()))
            elif action == 'invoice':
                kind = text(data,'kind')
                if kind not in ('销售发票','采购发票'):
                    raise BusinessError('发票类型无效')
                partner = self.one(db,'partners',ident(data,'partner_id'))
                if partner['kind'] != ('客户' if kind=='销售发票' else '供应商'):
                    raise BusinessError('发票类型与往来单位不匹配')
                gross = scaled(data.get('amount'),100,positive=True)
                tax = scaled(data.get('tax',0),100)
                if tax > gross:
                    raise BusinessError('税额不能超过价税合计')
                sale_id = purchase_id = None
                order_id = data.get('order_id')
                if order_id:
                    order = self.one(db,'sales' if kind=='销售发票' else 'purchases',ident(data,'order_id'))
                    if order['partner_id'] != partner['id']:
                        raise BusinessError('关联订单与往来单位不匹配')
                    column = 'sale_id' if kind=='销售发票' else 'purchase_id'
                    invoiced = db.execute(f"SELECT COALESCE(SUM(amount),0) FROM invoices WHERE {column}=? AND status='有效'",(order['id'],)).fetchone()[0]
                    if gross+invoiced > cost(order['qty'],order['price']):
                        raise BusinessError('累计有效发票金额超过订单金额')
                    if kind=='销售发票':
                        sale_id=order['id']
                    else:
                        purchase_id=order['id']
                shipment_ids,shipment_parts=self.invoice_shipments(db,data,partner['id'],kind)
                part_name = str(data.get('part_name','')).strip() or shipment_parts
                if not part_name and order_id:
                    part_name = self.one(db,'materials',order['product_id'] if kind=='销售发票' else order['material_id'])['name']
                part_name = text({'part_name':part_name},'part_name')
                ref=text(data,'number')
                db.execute('INSERT INTO invoices(number,kind,partner_id,sale_id,purchase_id,issued_on,amount,tax,note,actor,created,planned_on,part_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (ref,kind,partner['id'],sale_id,purchase_id,due_date(data,'issued_on'),gross,tax,str(data.get('note',''))[:160],actor,now(),due_date(data,'planned_on'),part_name))
                invoice_id=db.execute('SELECT last_insert_rowid()').fetchone()[0]
                db.executemany('INSERT INTO invoice_shipments VALUES(?,?)',[(invoice_id,key) for key in shipment_ids])
            elif action == 'invoice_details':
                invoice=self.one(db,'invoices',ident(data,'id'))
                if invoice['status']!='有效':
                    raise BusinessError('作废记录不能修改')
                db.execute('UPDATE invoices SET planned_on=?,part_name=? WHERE id=?',
                           (due_date(data,'planned_on'),text(data,'part_name'),invoice['id']))
                if 'shipment_ids' in data:
                    ids,_=self.invoice_shipments(db,data,invoice['partner_id'],invoice['kind'])
                    db.execute('DELETE FROM invoice_shipments WHERE invoice_id=?',(invoice['id'],))
                    db.executemany('INSERT INTO invoice_shipments VALUES(?,?)',[(invoice['id'],key) for key in ids])
                ref=invoice['number']
            elif action == 'invoice_payment':
                invoice=self.one(db,'invoices',ident(data,'id'))
                if invoice['status']!='有效':
                    raise BusinessError('作废记录不能登记收付款')
                settled=db.execute('SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id=?',(invoice['id'],)).fetchone()[0]
                kind='收款' if invoice['kind']=='销售发票' else '付款'
                oid=invoice['sale_id'] or invoice['purchase_id']
                order=self.one(db,'sales' if kind=='收款' else 'purchases',oid) if oid else None
                reference=order['number'] if order else 'INV:'+invoice['number']
                paid_on=due_date(data,'paid_on')
                existing=data.get('existing_payment_id')
                if existing:
                    payment=db.execute('SELECT * FROM payments WHERE id=?',(ident(data,'existing_payment_id'),)).fetchone()
                    if not payment or payment['invoice_id'] is not None or payment['reference']!=reference or payment['kind']!=kind:
                        raise BusinessError('请选择同一订单尚未关联发票的收付款记录')
                    amount=payment['amount']
                else:
                    amount=scaled(data.get('amount'),100,positive=True)
                if settled+amount > invoice['amount']:
                    raise BusinessError('本次金额超过发票未结余额')
                if existing:
                    db.execute("UPDATE payments SET invoice_id=?,paid_on=CASE WHEN paid_on='' THEN ? ELSE paid_on END WHERE id=?",(invoice['id'],paid_on,payment['id']))
                else:
                    if order:
                        order_paid=db.execute('SELECT COALESCE(SUM(amount),0) FROM payments WHERE reference=? AND kind=?',(reference,kind)).fetchone()[0]
                        if order_paid+amount > cost(order['qty'],order['price']):
                            raise BusinessError('金额超过订单未结余额；如已登记收付款，请关联已有记录，勿重复新增')
                    db.execute('INSERT INTO payments(kind,reference,amount,note,actor,created,invoice_id,paid_on) VALUES(?,?,?,?,?,?,?,?)',
                               (kind,reference,amount,str(data.get('note',''))[:160],actor,now(),invoice['id'],paid_on))
                ref=invoice['number']
            elif action == 'void_invoice':
                invoice=self.one(db,'invoices',ident(data,'id'))
                if invoice['status']!='有效':
                    raise BusinessError('该记录已经作废')
                if db.execute('SELECT 1 FROM payments WHERE invoice_id=?',(invoice['id'],)).fetchone():
                    raise BusinessError('该发票已有收付款记录，当前版本不支持直接作废，请先核对结算')
                db.execute("UPDATE invoices SET status='作废' WHERE id=?",(invoice['id'],))
                ref=invoice['number']
            elif action == 'payment':
                kind, ref = text(data,'kind'),text(data,'reference')
                if kind not in ('收款','付款'):
                    raise BusinessError('收付款类型无效')
                table = 'sales' if kind == '收款' else 'purchases'
                r = db.execute(f'SELECT * FROM {table} WHERE number=?',(ref,)).fetchone()
                if not r:
                    raise BusinessError('请选择对应销售单或采购单')
                amount = scaled(data.get('amount'),100,positive=True)
                paid = db.execute('SELECT COALESCE(SUM(amount),0) FROM payments WHERE kind=? AND reference=?',(kind,ref)).fetchone()[0]
                if paid+amount > cost(r['qty'],r['price']):
                    raise BusinessError('金额超过该单据未结余额')
                db.execute('INSERT INTO payments(kind,reference,amount,note,actor,created,paid_on) VALUES(?,?,?,?,?,?,?)', (kind,ref,amount,str(data.get('note',''))[:160],actor,now(),due_date(data,'paid_on') if data.get('paid_on') else datetime.now(BUSINESS_TZ).date().isoformat()))
            elif action == 'attachment':
                record_kind=text(data,'record_kind')
                if record_kind not in ('shipments','receipts'):
                    raise BusinessError('照片只能关联收货单或发货单')
                record=self.one(db,record_kind,ident(data,'record_id'))
                column='shipment_id' if record_kind=='shipments' else 'receipt_id'
                if db.execute(f'SELECT COUNT(*) FROM attachments WHERE {column}=?',(record['id'],)).fetchone()[0]>=10:
                    raise BusinessError('每张单据最多保存 10 张照片')
                try:
                    raw=base64.b64decode(data.get('content',''),validate=True)
                except (binascii.Error,ValueError,TypeError):
                    raise BusinessError('照片内容格式无效')
                if not 0<len(raw)<=8*1024*1024:
                    raise BusinessError('每张照片最大 8 MB')
                if raw.startswith(b'\xff\xd8\xff') and raw.endswith(b'\xff\xd9'):
                    mime='image/jpeg'
                elif raw.startswith(b'\x89PNG\r\n\x1a\n'):
                    mime='image/png'
                elif raw.startswith(b'RIFF') and raw[8:12]==b'WEBP':
                    mime='image/webp'
                else:
                    raise BusinessError('请上传 JPG、PNG 或 WebP 照片，不支持 SVG、HEIC 或其他文件')
                filename=text(data,'filename').replace('\\','/').rsplit('/',1)[-1]
                db.execute(f'INSERT INTO attachments({column},filename,mime,size,data,actor,created) VALUES(?,?,?,?,?,?,?)',
                           (record['id'],filename,mime,len(raw),raw,actor,now()))
                ref=record['number']
            elif action == 'password':
                r = self.one(db,'users',user['id'])
                if not secrets.compare_digest(password_hash(str(data.get('old_password','')),r['salt']),r['password']):
                    raise BusinessError('原密码不正确')
                pw = str(data.get('new_password',''))
                if len(pw)<12 or len(pw)>128:
                    raise BusinessError('新密码需为 12–128 个字符')
                salt=secrets.token_hex(16)
                db.execute('UPDATE users SET salt=?,password=? WHERE id=?',(salt,password_hash(pw,salt),r['id']))
                db.execute('DELETE FROM sessions WHERE user_id=?',(r['id'],))
                ref=user['username']
            else:
                raise BusinessError('未知操作')
            self.audit(db,actor,action,ref)
        return {'ok':True,'reference':ref}


class Handler(BaseHTTPRequestHandler):
    server_version = 'WorkshopERP'

    def log_message(self, fmt, *args):
        # Never log request bodies, cookies or login credentials.
        super().log_message(fmt,*args)

    def respond(self, status, body, content_type='application/json; charset=utf-8', cookie=None, attachment=None):
        raw = json.dumps(body,ensure_ascii=False).encode() if content_type.startswith('application/json') else body
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('X-Frame-Options','DENY')
        self.send_header('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if attachment:
            self.send_header('Content-Disposition',f'attachment; filename="{attachment}"')
        if cookie:
            self.send_header('Set-Cookie',cookie)
        self.end_headers()
        self.wfile.write(raw)

    def token(self):
        c = cookies.SimpleCookie()
        try:
            c.load(self.headers.get('Cookie',''))
            return c['session'].value if 'session' in c else ''
        except cookies.CookieError:
            return ''

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/health':
            return self.respond(200,{'ok':True})
        if path == '/api/state':
            user = self.server.erp.user(self.token())
            if not user:
                return self.respond(401,{'error':'请先登录'})
            return self.respond(200,self.server.erp.state(user))
        if path.startswith('/api/attachments/'):
            user=self.server.erp.user(self.token())
            if not user:
                return self.respond(401,{'error':'请先登录'})
            try:
                key=int(path.rsplit('/',1)[-1])
            except ValueError:
                return self.respond(404,{'error':'照片不存在'})
            with self.server.erp.connection() as db:
                photo=db.execute('SELECT mime,data FROM attachments WHERE id=?',(key,)).fetchone()
            if not photo:
                return self.respond(404,{'error':'照片不存在'})
            return self.respond(200,photo['data'],photo['mime'])
        assets = {
            '/': ('index.html', 'text/html; charset=utf-8'),
            '/help': ('help.html', 'text/html; charset=utf-8'),
            '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
            '/style.css': ('style.css', 'text/css; charset=utf-8'),
            '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json; charset=utf-8'),
            '/icon.svg': ('icon.svg', 'image/svg+xml'),
        }
        if path in assets:
            file, mime = assets[path]
            return self.respond(200,(ROOT/'static'/file).read_bytes(),mime)
        self.respond(404,{'error':'页面不存在'})

    def do_POST(self):
        # JSON-only writes + same-origin validation protect cookie-authenticated actions.
        origin = self.headers.get('Origin')
        if origin and origin not in ('http://'+self.headers.get('Host',''),'https://'+self.headers.get('Host','')):
            return self.respond(403,{'error':'不允许跨站操作'})
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return self.respond(403,{'error':'不允许跨站操作'})
        if self.headers.get('Content-Type','').split(';')[0] != 'application/json':
            return self.respond(415,{'error':'需要 application/json'})
        path = urlsplit(self.path).path
        try:
            length = int(self.headers.get('Content-Length','0'))
            if length <= 0 or length > (12*1024*1024 if path=='/api/actions/attachment' else 65536):
                return self.respond(413,{'error':'请求大小无效'})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data,dict):
                raise ValueError
        except (ValueError,UnicodeDecodeError):
            return self.respond(400,{'error':'JSON 格式无效'})
        path = urlsplit(self.path).path
        try:
            if path == '/api/login':
                key = self.client_address[0]
                with self.server.login_lock:
                    attempts = [t for t in self.server.attempts.get(key,[]) if t > datetime.now().timestamp()-60]
                    if len(attempts)>=10:
                        return self.respond(429,{'error':'登录尝试过多，请一分钟后重试'})
                    attempts.append(datetime.now().timestamp())
                    self.server.attempts[key]=attempts
                token=self.server.erp.login(str(data.get('username',''))[:160],str(data.get('password',''))[:1024])
                return self.respond(200,{'ok':True},cookie=f'session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+ ('; Secure' if self.server.secure_cookie else ''))
            user = self.server.erp.user(self.token())
            if not user:
                return self.respond(401,{'error':'请先登录'})
            if path == '/api/backup':
                if user['role'] != '管理':
                    return self.respond(403,{'error':'只有管理员可以下载备份'})
                from backup import backup
                with tempfile.TemporaryDirectory() as folder:
                    destination = backup(self.server.erp.dbpath, Path(folder)/'erp-backup.sqlite3')
                    raw = destination.read_bytes()
                with self.server.erp.connection() as db:
                    self.server.erp.audit(db,user['name'],'backup','数据库备份下载')
                return self.respond(200,raw,'application/octet-stream',attachment='erp-backup-'+datetime.now(BUSINESS_TZ).strftime('%Y%m%d-%H%M%S')+'.sqlite3')
            if path == '/api/logout':
                with self.server.erp.connection() as db:
                    db.execute('DELETE FROM sessions WHERE token=?',(self.token(),))
                return self.respond(200,{'ok':True},cookie='session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
            if path.startswith('/api/actions/'):
                return self.respond(200,self.server.erp.action(user,path.rsplit('/',1)[-1],data))
            self.respond(404,{'error':'接口不存在'})
        except BusinessError as e:
            self.respond(400,{'error':str(e)})
        except sqlite3.IntegrityError:
            self.respond(400,{'error':'编号重复或关联资料无效，请检查输入'})
        except (ValueError,TypeError,KeyError):
            self.respond(400,{'error':'输入格式无效'})
        except Exception:
            import traceback
            traceback.print_exc()
            self.respond(500,{'error':'服务器处理失败，请查看服务日志'})


class ERPServer(ThreadingHTTPServer):
    def __init__(self, *args, **kwargs):
        self.next_backup_check = 0
        self.backup_worker = None
        super().__init__(*args, **kwargs)

    def service_actions(self):
        # Runs even without browser requests. File I/O is performed outside the HTTP loop.
        if time.monotonic() >= self.next_backup_check and (self.backup_worker is None or not self.backup_worker.is_alive()):
            self.next_backup_check = time.monotonic() + 60
            self.backup_worker = threading.Thread(target=self.erp.monthly_backup.run_once, daemon=True)
            self.backup_worker.start()

    def server_close(self):
        super().server_close()
        if self.backup_worker is not None:
            self.backup_worker.join()


def make_server(erp, host='127.0.0.1', port=8000, secure_cookie=False):
    server = ERPServer((host,port),Handler)
    server.erp = erp
    server.secure_cookie = secure_cookie
    server.login_lock = threading.Lock()
    server.attempts = {}
    return server


def main():
    parser=argparse.ArgumentParser(description='小型汽配制造 ERP')
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--data-dir',default=str(ROOT/'.data'))
    parser.add_argument('--demo',action='store_true')
    parser.add_argument('--secure-cookie',action='store_true',help='通过 HTTPS 反向代理使用时开启')
    args=parser.parse_args()
    directory=Path(args.data_dir)
    erp=ERP(directory,args.demo)
    if args.demo:
        (directory/'demo-mode').touch()
    server=make_server(erp,args.host,args.port,args.secure_cookie)
    print(f'ERP listening on {args.host}:{args.port}. Initial accounts: {directory}/initial-accounts.txt',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
