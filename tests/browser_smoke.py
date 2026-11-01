"""Optional real-browser workflow check. Requires Playwright and Chromium."""
from pathlib import Path
import sys
import tempfile
import threading
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import ERP, make_server
from playwright.sync_api import sync_playwright


def run(mobile=False):
    with tempfile.TemporaryDirectory() as directory:
        erp=ERP(directory,True)
        Path(directory,'demo-mode').touch()
        server=make_server(erp,port=0)
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(executable_path='/usr/bin/chromium',args=['--no-sandbox'])
                page=browser.new_page(viewport={'width':390,'height':844} if mobile else {'width':1440,'height':1000},is_mobile=mobile,has_touch=mobile)
                errors=[]
                page.on('pageerror',lambda err:errors.append(str(err)))
                base=f'http://127.0.0.1:{server.server_port}'
                page.goto(base+'/help')
                assert '四个人，各自使用独立账号' in page.inner_text('body')
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                page.goto(base)
                assert page.locator('a.help-link').is_visible()
                password=[l.split(': ',1)[1] for l in Path(directory,'initial-accounts.txt').read_text().splitlines() if l.startswith('admin:')][0]
                page.locator('#login-form [name=username]').fill('admin')
                page.locator('#login-form [name=password]').fill(password)
                page.get_by_role('button',name='进入工作台').click()
                page.locator('#shell:not(.hidden)').wait_for()
                page.screenshot(path='/tmp/erp-dashboard.png',full_page=True)
                for route in ['sales','production','purchases','inventory','finance','master','audit','dashboard']:
                    page.locator(f'#nav a[href="#{route}"]').click()
                    page.locator('#page h1').wait_for()
                    if mobile:
                        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),route
                        assert page.locator('#page tbody td[data-label], #page td.empty').count() or route=='production'
                def open_action(action):
                    page.locator(f'#page .primary[data-action="{action}"]').click()
                def fill(key,value):
                    page.locator(f'#modal [name="{key}"]').fill(str(value))
                def select(key,value):
                    page.locator(f'#modal [name="{key}"]').select_option(str(value))
                def save():
                    page.locator('#modal-submit').click()
                    page.locator('#modal').wait_for(state='hidden')
                def route(name):
                    page.locator(f'#nav a[href="#{name}"]').click()
                # A full manufacturing cycle through the actual UI.
                route('sales');open_action('sale')
                select('partner_id',1);select('product_id',3);fill('qty','10');fill('price','48');save()
                sale_number=page.locator('#page tbody tr').first.locator('.mono').inner_text()
                page.locator('#page tbody tr').first.get_by_role('button',name='安排生产').click();save()
                route('production')
                page.get_by_role('button',name='按 BOM 领料').first.click();save()
                for step in ['模切','缝纫','背胶','检验']:
                    page.get_by_role('button',name='完成 '+step,exact=True).click();save()
                page.get_by_role('button',name='完工入库',exact=True).click()
                fill('batch','UI-FG-001');fill('processing_cost','30');save()
                route('sales')
                row=page.locator('#page tbody tr').filter(has_text=sale_number)
                row.get_by_role('button',name='确认发货').click();save()
                assert '已发货' in row.inner_text()
                if mobile:
                    bounds=row.bounding_box()
                    assert bounds['x']>=0 and bounds['x']+bounds['width']<=391
                # Buy/resell trading cycle, without any work order.
                route('purchases');open_action('purchase')
                select('partner_id',3);select('material_id',5);fill('qty','20');fill('price','35');save()
                page.get_by_role('button',name='收货入库').first.click();fill('batch','UI-TRADE-001');save()
                route('sales');open_action('sale')
                select('partner_id',1);select('product_id',5);fill('qty','8');fill('price','68');save()
                trade_number=page.locator('#page tbody tr').first.locator('.mono').inner_text()
                page.locator('#page tbody tr').first.get_by_role('button',name='确认发货').click();save()
                route('finance');open_action('payment')
                select('reference',trade_number);fill('amount','544');fill('note','浏览器验收');save()
                page.get_by_role('button',name='收付款流水',exact=True).click()
                assert '544.00' in page.locator('#page').inner_text()
                route('inventory');page.get_by_role('button',name='批次追溯',exact=True).click()
                page.locator('#page tbody tr').filter(has_text='UI-FG-001').get_by_role('button',name='追溯').click()
                assert '生产领料' in page.locator('#modal').inner_text()
                page.locator('#modal-close').click()
                # XSS stays text after rendering a user-supplied material name.
                route('master');open_action('material')
                fill('code','XSS-1');fill('name','<img src=x onerror=alert(1)>');select('kind','原材料');save()
                assert page.locator('#page tbody img').count()==0
                route('dashboard')
                page.set_viewport_size({'width':390,'height':844})
                page.screenshot(path='/tmp/erp-mobile.png',full_page=True)
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                page.locator('#mobile-logout').click()
                page.locator('#login:not(.hidden)').wait_for()
                assert errors==[],errors
                browser.close()
                print(('Mobile' if mobile else 'Desktop')+' Browser PASS: all pages, manufacturing, trade, payment, trace, escaped content, mobile layout; no JS errors.')
        finally:
            server.shutdown();server.server_close();thread.join()

if __name__=='__main__':
    run(mobile='--mobile' in sys.argv)
