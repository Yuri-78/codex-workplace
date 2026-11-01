'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const qty = n => new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(n/1000);
const money = n => '¥'+new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n/100);
const amount = r => Math.round(r.qty*r.price/1000);
const today = () => new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
const afterWeek = () => {const d=new Date();d.setDate(d.getDate()+7);return d.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});};
const pages = [['dashboard','◫','经营概览'],['sales','▤','销售订单'],['shipments','⇥','出货记录'],['invoices','▧','发票记录'],['production','⚙','生产管理'],['purchases','⇣','采购管理'],['inventory','▦','库存与批次'],['finance','◈','收支与成本'],['master','⊞','基础资料'],['audit','≡','操作记录']];
let S, current='dashboard', tab='', search='', busy=false;
const material = id => S.materials.find(r=>r.id===Number(id)) || {};
const partner = id => S.partners.find(r=>r.id===Number(id)) || {};
const stock = id => S.lots.filter(r=>r.material_id===id).reduce((a,r)=>a+r.qty,0);
const unit = id => material(id).unit || '';
const name = id => esc(material(id).name || '—');
const pName = id => esc(partner(id).name || '—');
const paid = (kind,ref) => S.payments.filter(p=>p.kind===kind && p.reference===ref).reduce((a,r)=>a+r.amount,0);
const can = action => S.user.role==='管理' || ({业务:['sale','purchase','partner','payment','invoice','void_invoice'],仓库:['opening','receive','ship'],生产:['work','issue','advance','complete']}[S.user.role]||[]).includes(action);
function btn(action,label,id,extra=''){return can(action)?`<button data-action="${action}" ${id?`data-id="${id}"`:''} ${extra}>${label}</button>`:'';}
function badge(status){const cl=({'已发货':'green','已收货':'green','已完工':'green','生产中':'blue','待领料':'warn','待发货':'warn','待收货':'warn'})[status]||'';return `<span class="pill ${cl}">${esc(status)}</span>`;}
function table(headers,rows,empty='暂无记录，点击右上角按钮开始录入'){return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>{let index=0;return row.replace(/<td>/g,()=>`<td data-label="${esc(headers[index++]||'')}">`);}).join(''):`<tr><td colspan="${headers.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;}
const tr = (...cells)=>`<tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr>`;
function panel(title,body,right=''){return `<section class="panel"><div class="panel-head"><h2>${title}</h2>${right}</div>${body}</section>`;}
function heading(en,title,description,action,label){return `<div class="page-heading"><div><span class="eyebrow">${en}</span><h1>${title}</h1><p>${description}</p></div>${action&&can(action)?`<button class="primary" data-action="${action}">＋ ${label}</button>`:''}</div>`;}
function stat(label,value,hint,icon='↗',accent=false){return `<div class="stat ${accent?'accent':''}"><div class="stat-label">${label}<b>${icon}</b></div><div class="stat-value">${value}</div><small>${hint}</small></div>`;}
function toolbar(tabs){return `<div class="toolbar"><div class="tabs">${tabs.map(t=>`<button data-tab="${t}" class="${tab===t?'active':''}">${t}</button>`).join('')}</div><input id="search" class="search" type="search" placeholder="搜索编号、名称、批次…" aria-label="搜索" value="${esc(search)}"></div>`;}
function match(...values){return !search || values.some(v=>String(v??'').toLowerCase().includes(search.toLowerCase()));}
function salesRows(list,compact=false){return list.map(r=>tr(`<strong class="mono">${esc(r.number)}</strong><small>${pName(r.partner_id)}</small>`,`${name(r.product_id)}<small>${material(r.product_id).kind} · ${qty(r.qty)} ${esc(unit(r.product_id))}</small>`,money(amount(r)),`<span class="${r.due<today()&&r.status!=='已发货'?'ledger-negative':''}">${esc(r.due)}</span>`,badge(r.status),compact?'':`<div class="row-actions">${r.status==='待发货'?btn('ship','确认发货',r.id)+ (material(r.product_id).kind==='成品'?btn('work','安排生产',r.id,'data-sale="true"'):''):''}</div>`));}
function productionProgress(r){const steps=JSON.parse(r.steps);return `<div class="steps">${steps.map((s,i)=>`<span class="${i<r.step?'done':i===r.step&&r.status==='生产中'?'current':''}">${i<r.step?'✓ ':''}${esc(s)}${i<steps.length-1?' →':''}</span>`).join('')}</div><progress class="progress" value="${r.step}" max="${steps.length}" aria-label="工序完成进度"></progress>`;}
function dashboard(){
 const orders=S.sales.filter(r=>r.status==='待发货'), works=S.workorders.filter(r=>r.status!=='已完工');
 const low=S.materials.filter(m=>stock(m.id)<m.min_qty);
 const value=S.lots.reduce((a,r)=>a+Math.round(r.qty*r.unit_cost/1000),0);
 const sales=S.sales.filter(r=>r.status==='已发货').reduce((a,r)=>a+amount(r),0);
 const cogs=-S.movements.filter(r=>r.kind==='销售出库').reduce((a,r)=>a+r.amount,0);
 return heading('BUSINESS OVERVIEW','经营概览','订单有进度，库存有依据，经营心中有数。')+
 `<div class="cards">${stat('待交付订单',orders.length,`订单金额 ${money(orders.reduce((a,r)=>a+amount(r),0))}`,'▤',true)}${stat('进行中的生产',works.length,'工序：模切 / 缝纫 / 背胶 / 检验','⚙')}${stat('当前库存货值',money(value),`${low.length} 项物料低于安全库存`,'▦')}${stat('已发货毛利',money(sales-cogs),'销售收入 − 批次出库成本（未计税费）','↗')}</div>`+
 `<div class="grid-two">${panel('近期交付订单 <small>按交期排序</small>',table(['订单 / 客户','产品 / 数量','订单金额','交付日期','状态',''],salesRows([...orders].sort((a,b)=>a.due.localeCompare(b.due)).slice(0,5),true)),' <a class="link" href="#sales">全部订单 →</a>')}${panel('库存预警',low.length?`<div class="warning-list">${low.slice(0,5).map(m=>`<div class="warning-item"><span class="warning-icon">!</span><div><strong>${esc(m.name)}</strong><small>现存 ${qty(stock(m.id))} / 安全库存 ${qty(m.min_qty)} ${esc(m.unit)}</small></div><span class="pill warn">需补充</span></div>`).join('')}</div>`:'<div class="empty">库存充足，暂无预警</div>','<a class="link" href="#inventory">查看库存 →</a>')}</div>`+
 `<div class="grid-two">${panel('生产动态',works.length?`<div class="work-list">${works.slice(0,4).map(r=>`<div class="work-item"><div class="work-top"><strong>${name(r.product_id)} <small>${qty(r.qty)} ${esc(unit(r.product_id))}</small></strong>${badge(r.status)}</div>${productionProgress(r)}<small class="metric-hint">${esc(r.number)} · 计划完成 ${esc(r.due)}</small></div>`).join('')}</div>`:'<div class="empty">暂无生产工单，销售接单后可直接安排生产</div>','<a class="link" href="#production">生产看板 →</a>')}${panel('最近业务记录',table(['业务','操作人','时间'],S.audit.slice(0,5).map(r=>tr(`${esc(actionNames[r.action]||r.action)}<small class="mono">${esc(r.reference)}</small>`,esc(r.actor),dateTime(r.created)))))}</div>`;
}
const actionNames={material:'新增物料',partner:'新增往来单位',bom:'维护 BOM',opening:'期初入库',sale:'新建销售单',purchase:'新建采购单',receive:'采购收货',work:'新建生产单',issue:'生产领料',advance:'工序报工',complete:'完工入库',ship:'登记出货',invoice:'登记发票',void_invoice:'作废发票记录',backup:'下载数据库备份',payment:'登记收付款',password:'修改密码',reset_password:'管理员重置密码'};
const dateTime=s=>esc(new Date(s).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}));
function salesPage(){
 const list=S.sales.filter(r=>(tab==='全部'||r.status===tab)&&match(r.number,material(r.product_id).name,partner(r.partner_id).name));
 return heading('SALES ORDERS','销售订单','自产产品与代理商品统一接单，按交期跟踪交付。','sale','新增销售单')+toolbar(['全部','待发货','已发货'])+panel('订单列表',table(['订单 / 客户','产品 / 数量','订单金额','交付日期','状态','操作'],salesRows(list)));
}
function productionPage(){
 const list=S.workorders.filter(r=>(tab==='全部'||r.status===tab)&&match(r.number,material(r.product_id).name));
 const demand=new Map();
 S.requirements.filter(r=>S.workorders.some(w=>w.id===r.work_id&&w.status==='待领料')).forEach(r=>demand.set(r.material_id,(demand.get(r.material_id)||0)+r.qty));
 return heading('PRODUCTION','生产管理','按单生产为主，兼顾备货；每张工单冻结创建时的 BOM 用量。','work','新增工单')+toolbar(['全部','待领料','生产中','已完工'])+
 panel('生产工单',table(['工单 / 用途','产品 / 数量','工序进度','计划完成','状态','操作'],list.map(r=>tr(`<strong class="mono">${esc(r.number)}</strong><small>${r.sale_id?esc(S.sales.find(s=>s.id===r.sale_id)?.number):'备货生产'}</small>`,`${name(r.product_id)}<small>${qty(r.qty)} ${esc(unit(r.product_id))}</small>`,productionProgress(r),esc(r.due),badge(r.status),`<div class="row-actions">${r.status==='待领料'?btn('issue','按 BOM 领料',r.id):r.status==='生产中'?(r.step<JSON.parse(r.steps).length?btn('advance','完成 '+JSON.parse(r.steps)[r.step],r.id):btn('complete','完工入库',r.id)):'<a class="link" href="#finance">查看成本 →</a>'}</div>`))))+
 panel('待领料需求汇总 <small>按已建工单计算；尚未建单的销售需求不计入</small>',table(['物料','工单需求','当前库存','缺料数量'],[...demand].map(([id,n])=>tr(name(id),`${qty(n)} ${esc(unit(id))}`,qty(stock(id)),stock(id)<n?`<span class="pill red">缺 ${qty(n-stock(id))}</span>`:'<span class="pill green">充足</span>')),'暂无待领料工单'));
}
function purchasePage(){const list=S.purchases.filter(r=>(tab==='全部'||r.status===tab)&&match(r.number,material(r.material_id).name,partner(r.partner_id).name));return heading('PURCHASING','采购管理','采购原材料用于生产，采购贸易商品直接销售。','purchase','新增采购单')+toolbar(['全部','待收货','已收货'])+panel('采购订单',table(['采购单 / 供应商','物料 / 类型','数量','采购金额','状态','操作'],list.map(r=>tr(`<strong class="mono">${esc(r.number)}</strong><small>${pName(r.partner_id)}</small>`,`${name(r.material_id)}<small>${esc(material(r.material_id).kind)}</small>`,`${qty(r.qty)} ${esc(unit(r.material_id))}`,money(amount(r)),badge(r.status),`<div class="row-actions">${r.status==='待收货'?btn('receive','收货入库',r.id):''}</div>`))));}
function shipmentPage(){
 const rows=S.shipments.filter(h=>{const sale=S.sales.find(r=>r.id===h.sale_id)||{};return match(h.number,sale.number,partner(sale.partner_id).name,h.receiver,h.carrier,h.tracking,material(sale.product_id).name);});
 return heading('SHIPMENT RECORDS','出货记录','独立查询每次出货的订单、物流及批次；目前按销售单整单出货。','ship','登记出货')+toolbar([])+panel('出货台账',table(['出货单 / 销售单','客户 / 收货信息','产品 / 数量','出货日期','物流 / 运单号','出库批次','备注 / 经办人'],rows.map(h=>{const sale=S.sales.find(r=>r.id===h.sale_id)||{};const moves=S.movements.filter(m=>m.reference===sale.number&&m.kind==='销售出库');return tr(`<strong class="mono">${esc(h.number)}</strong><small>${esc(sale.number)}</small>`,`${pName(sale.partner_id)}<small>${esc(h.receiver||'未填写')} · ${esc(h.address)}</small>`,`${name(sale.product_id)}<small>${qty(sale.qty)} ${esc(unit(sale.product_id))}</small>`,esc(h.shipped_on||'历史日期未知'),`${esc(h.carrier||'未填写')}<small class="mono">${esc(h.tracking)}</small>`,moves.map(m=>`<span class="mono">${esc(m.batch)}</span><small>${qty(-m.qty)} ${esc(unit(m.material_id))}</small>`).join(''),`${esc(h.note)}<small>${esc(h.actor)}</small>`);})));
}
function invoicePage(){
 const valid=S.invoices.filter(r=>r.status==='有效');
 const records=S.invoices.filter(r=>(tab==='全部'||r.kind===tab)&&match(r.number,partner(r.partner_id).name,r.note,(r.sale_id?S.sales:S.purchases).find(o=>o.id===(r.sale_id||r.purchase_id))?.number));
 return heading('INVOICE REGISTER','发票记录','手工登记销售及采购发票，可独立登记，也可关联订单。','invoice','登记发票')+`<div class="note">这里记录已在税务系统开具或收到的发票，不提供税务开票、验真或抵扣申报。登记发票不改变库存、收付款或已发货毛利；“作废”仅作废本系统的记录。</div><div class="cards">${stat('有效销售发票',money(valid.filter(r=>r.kind==='销售发票').reduce((a,r)=>a+r.amount,0)),'价税合计 · 全部期间','▧',true)}${stat('有效采购发票',money(valid.filter(r=>r.kind==='采购发票').reduce((a,r)=>a+r.amount,0)),'价税合计 · 全部期间','▧')}${stat('有效发票数',valid.length,'不含已作废记录','≡')}${stat('已作废记录',S.invoices.length-valid.length,'保留原记录和操作日志','↶')}</div>`+toolbar(['全部','销售发票','采购发票'])+panel('发票台账',table(['发票号码 / 类型','往来单位','开票日期','价税合计 / 不含税','税额','关联订单','状态 / 操作'],records.map(r=>{const order=r.sale_id?S.sales.find(o=>o.id===r.sale_id):S.purchases.find(o=>o.id===r.purchase_id);return tr(`<strong class="mono">${esc(r.number)}</strong><small>${esc(r.kind)}</small>`,`${pName(r.partner_id)}<small>${esc(r.note)}</small>`,esc(r.issued_on),`${money(r.amount)}<small>不含税 ${money(r.amount-r.tax)}</small>`,money(r.tax),`<span class="mono">${esc(order?.number||'独立登记')}</span>`,`${badge(r.status)}<div class="row-actions">${r.status==='有效'?btn('void_invoice','作废记录',r.id):''}</div>`);})));
}
function inventoryPage(){
 let body;
 if(tab==='库存余额')body=table(['物料 / 编码','类型','当前库存','安全库存','库存货值','状态'],S.materials.filter(m=>match(m.code,m.name,m.kind)).map(m=>tr(`<strong>${esc(m.name)}</strong><small class="mono">${esc(m.code)}</small>`,badge(m.kind),`${qty(stock(m.id))} ${esc(m.unit)}`,qty(m.min_qty),money(S.lots.filter(l=>l.material_id===m.id).reduce((a,l)=>a+Math.round(l.qty*l.unit_cost/1000),0)),stock(m.id)<m.min_qty?'<span class="pill warn">低于安全库存</span>':'<span class="pill green">正常</span>')));
 else if(tab==='批次追溯')body=`<div class="total-line">搜索批号或业务单号，可查看原料 → 生产工单 → 成品 → 销售单的关联流水。点击批号可追溯相关工单。</div>`+table(['物料','批次','当前数量','单位成本','来源单据','操作'],S.lots.filter(l=>match(l.batch,l.source,material(l.material_id).name)).map(l=>tr(name(l.material_id),`<strong class="mono">${esc(l.batch)}</strong>`,`${qty(l.qty)} ${esc(unit(l.material_id))}`,money(l.unit_cost),`<span class="mono">${esc(l.source)}</span>`,`<div class="row-actions"><button data-trace="${l.id}">追溯</button></div>`)));
 else body=table(['时间 / 操作人','物料','批次','业务类型','数量变化','成本金额','关联单据'],S.movements.filter(r=>match(r.batch,r.reference,material(r.material_id).name,r.kind)).map(r=>tr(`${dateTime(r.created)}<small>${esc(r.actor)}</small>`,name(r.material_id),`<span class="mono">${esc(r.batch)}</span>`,badge(r.kind),`<span class="${r.qty>0?'ledger-positive':'ledger-negative'}">${r.qty>0?'+':''}${qty(r.qty)} ${esc(unit(r.material_id))}</span>`,money(r.amount),`<span class="mono">${esc(r.reference)}</span>`)));
 return heading('INVENTORY & TRACEABILITY','库存与批次','单据驱动库存变动，先进先出领料和发货，保留每个批次的来源。','opening','期初入库')+toolbar(['库存余额','批次追溯','库存流水'])+panel(tab,body);
}
function financePage(){
 const receive=S.sales.reduce((a,r)=>a+amount(r)-paid('收款',r.number),0),pay=S.purchases.reduce((a,r)=>a+amount(r)-paid('付款',r.number),0);
 let body;
 if(tab==='订单结算')body=table(['单据','往来单位','合同金额','已结金额','未结余额','交付状态'],[...S.sales.map(r=>({...r,kind:'收款'})),...S.purchases.map(r=>({...r,kind:'付款'}))].filter(r=>match(r.number,partner(r.partner_id).name)).map(r=>tr(`<strong class="mono">${esc(r.number)}</strong><small>${r.kind==='收款'?'销售收款':'采购付款'}</small>`,pName(r.partner_id),money(amount(r)),money(paid(r.kind,r.number)),money(amount(r)-paid(r.kind,r.number)),badge(r.status))));
 else if(tab==='生产成本')body=table(['工单','产品','状态','数量','材料成本','加工成本','总成本 / 单位成本'],S.workorders.filter(r=>match(r.number,material(r.product_id).name)).map(r=>tr(`<span class="mono">${esc(r.number)}</span>`,name(r.product_id),badge(r.status),qty(r.qty),money(r.material_cost),r.status==='已完工'?money(r.processing_cost):'待完工登记',r.status==='已完工'?`${money(r.material_cost+r.processing_cost)}<small>单位 ${money(Math.round((r.material_cost+r.processing_cost)*1000/r.qty))}</small>`:'—')));
 else body=table(['时间','类型','关联单据','金额','备注','操作人'],S.payments.filter(r=>match(r.reference,r.note,r.kind)).map(r=>tr(dateTime(r.created),badge(r.kind),`<span class="mono">${esc(r.reference)}</span>`,money(r.amount),esc(r.note),esc(r.actor))));
 return heading('CASHFLOW & COST','收支与成本','按单登记收付款，追踪自产和贸易的实际出库成本。','payment','登记收付款')+`<div class="cards">${stat('销售未结余额',money(receive),'含未发货订单，按合同总额计算','↙',true)}${stat('采购未结余额',money(pay),'含未收货订单，按合同总额计算','↗')}${stat('累计收款',money(S.payments.filter(r=>r.kind==='收款').reduce((a,r)=>a+r.amount,0)),'按手工登记记录汇总','＋')}${stat('累计付款',money(S.payments.filter(r=>r.kind==='付款').reduce((a,r)=>a+r.amount,0)),'按手工登记记录汇总','−')}</div><div class="note">成本为简化管理口径：原材料按批次成本计价，人工、制造及外协费用在完工时汇总登记；未包含税务核算、费用分摊或总账。每单位入库成本保留至分，可能产生舍入差异。</div>`+panel('已发货毛利 <small>按业务类型区分 · 全部期间</small>',table(['业务类型','销售收入','实际出库成本','毛利（未计税费）'],['成品','贸易商品'].map(kind=>{const sales=S.sales.filter(r=>r.status==='已发货'&&material(r.product_id).kind===kind);const refs=new Set(sales.map(r=>r.number));const revenue=sales.reduce((a,r)=>a+amount(r),0);const cogs=-S.movements.filter(m=>m.kind==='销售出库'&&refs.has(m.reference)).reduce((a,m)=>a+m.amount,0);return tr(kind==='成品'?'自产产品':'代理贸易',money(revenue),money(cogs),money(revenue-cogs));})))+toolbar(['订单结算','生产成本','收付款流水'])+panel(tab,body);
}
function masterPage(){
 let body,action,label;
 if(tab==='物料与商品'){action='material';label='新增物料';body=table(['编码','名称','类型','单位','安全库存','参考单价'],S.materials.filter(r=>match(r.code,r.name,r.kind)).map(r=>tr(`<span class="mono">${esc(r.code)}</span>`,esc(r.name),badge(r.kind),esc(r.unit),qty(r.min_qty),money(r.price))));}
 else if(tab==='往来单位'){action='partner';label='新增往来单位';body=table(['名称','类型','联系人 / 备注'],S.partners.filter(r=>match(r.name,r.kind,r.contact)).map(r=>tr(esc(r.name),badge(r.kind),esc(r.contact))));}
 else{action='bom';label='维护 BOM';body='<div class="total-line">用量 = 生产 1 单位成品所需的原材料数量。修改只影响新建工单；已建工单保留原用量。</div>'+table(['成品','原材料','每单位用量'],S.bom.filter(r=>match(material(r.product_id).name,material(r.material_id).name)).map(r=>tr(name(r.product_id),name(r.material_id),`${qty(r.qty)} ${esc(unit(r.material_id))}`)));}
 return heading('MASTER DATA','基础资料','维护自产成品、贸易商品及原材料，统一业务数据来源。',action,label)+toolbar(['物料与商品','往来单位','生产 BOM'])+panel(tab,body);
}
function auditPage(){return heading('ACTIVITY LOG','操作记录','关键业务动作保留操作人、时间及关联单据。')+toolbar([])+panel('业务操作日志',table(['时间','操作人','操作','关联单据'],S.audit.filter(r=>match(r.actor,r.action,r.reference,actionNames[r.action])).map(r=>tr(dateTime(r.created),esc(r.actor),esc(actionNames[r.action]||r.action),`<span class="mono">${esc(r.reference)}</span>`))));}
function render(){
 const focus=$('#search')===document.activeElement, caret=focus?$('#search').selectionStart:0;
 $('#page').innerHTML=({dashboard,sales:salesPage,shipments:shipmentPage,invoices:invoicePage,production:productionPage,purchases:purchasePage,inventory:inventoryPage,finance:financePage,master:masterPage,audit:auditPage}[current])();
 $('#crumb').textContent=pages.find(p=>p[0]===current)[2];
 $('#nav').innerHTML=pages.map(([id,icon,title])=>`<a href="#${id}" class="${current===id?'active':''}"><span class="nav-icon">${icon}</span>${title}</a>`).join('');
 if(focus&&$('#search')){$('#search').focus();try{$('#search').setSelectionRange(caret,caret);}catch{}}
}
function route(){current=location.hash.slice(1);if(!pages.some(p=>p[0]===current))current='dashboard';search='';tab=({sales:'全部',invoices:'全部',production:'全部',purchases:'全部',inventory:'库存余额',finance:'订单结算',master:'物料与商品'})[current]||'';if(S)render();}
async function api(path,data){const response=await fetch(path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const body=await response.json();if(!response.ok){if(response.status===401)showLogin();throw new Error(body.error||'请求失败');}return body;}
function showLogin(){$('#shell').classList.add('hidden');$('#login').classList.remove('hidden');S=null;}
async function load(){S=await api('/api/state');$('#login').classList.add('hidden');$('#shell').classList.remove('hidden');$('#backup').classList.toggle('hidden',S.user.role!=='管理');$('#user-name').textContent=S.user.name;$('#user-role').textContent=S.user.role+'账号';$('#avatar').textContent=S.user.name[0];$('#demo-banner').classList.toggle('hidden',!S.demo);render();}
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),4000);}
function input(label,key,type='text',value='',opts={}){return `<label class="${opts.full?'full':''}">${label}<input name="${key}" type="${type}" value="${esc(value)}" ${opts.optional?'':'required'} ${type==='number'?`min="${opts.positive?'0.001':'0'}" step="${opts.money?'0.01':'0.001'}" max="100000000"`:''} ${type==='password'?'autocomplete="off"':''} ${opts.maxlength?`maxlength="${opts.maxlength}"`:''}></label>`;}
function select(label,key,options,selected='',optional=false){return `<label>${label}<select name="${key}" ${optional?'':'required'}><option value="">${optional?esc(typeof optional==='string'?optional:'不关联（备货）'):'请选择'}</option>${options.map(([v,t])=>`<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;}
function materialOptions(kinds){return S.materials.filter(m=>kinds.includes(m.kind)).map(m=>[m.id,`${m.code} · ${m.name}（${m.unit}）`]);}
function partnerOptions(kind){return S.partners.filter(p=>p.kind===kind).map(p=>[p.id,p.name]);}
let pendingAction;
function modal(action,id,forSale=false){
 let title=actionNames[action]||'',fields='',data={},r;
 const q=input('数量','qty','number','',{positive:true});
 const price=input('单价（元 / 单位）','price','number','',{money:true});
 if(action==='material'){fields=input('物料编码','code')+input('名称','name')+select('类型','kind',['原材料','成品','贸易商品'].map(x=>[x,x]))+input('计量单位','unit','text','件')+input('安全库存','min_qty','number',0)+input('参考单价（元）','price','number',0,{money:true});}
 else if(action==='partner')fields=input('单位名称','name')+select('类型','kind',['客户','供应商'].map(x=>[x,x]))+input('联系人 / 备注','contact','text','',{optional:true,full:true});
 else if(action==='bom')fields=select('成品','product_id',materialOptions(['成品']))+select('原材料','material_id',materialOptions(['原材料']))+input('每 1 单位成品的用量','qty','number','',{positive:true})+'<div class="note full">已有成品与原材料组合会更新用量。已建工单用量不会改变。</div>';
 else if(action==='opening')fields=select('物料','material_id',materialOptions(['原材料','成品','贸易商品']))+input('批次号','batch')+q+input('单位成本（元）','price','number','',{money:true})+'<div class="note full">仅用于首次上线前现有库存建账。日常采购请通过采购单收货。</div>';
 else if(action==='sale'||action==='purchase'){const sale=action==='sale';fields=select(sale?'客户':'供应商','partner_id',partnerOptions(sale?'客户':'供应商'))+select(sale?'销售产品':'采购物料',sale?'product_id':'material_id',materialOptions(sale?['成品','贸易商品']:['原材料','贸易商品']))+q+price+(sale?input('交付日期','due','date',afterWeek()):'');}
 else if(action==='work'){
  const sale=forSale?S.sales.find(s=>s.id===id):null;
  title='新建生产工单';
  fields=select('关联销售订单','sale_id',S.sales.filter(s=>s.status==='待发货'&&material(s.product_id).kind==='成品').map(s=>[s.id,`${s.number} · ${material(s.product_id).name}`]),sale?.id,true)+select('自产成品','product_id',materialOptions(['成品']),sale?.product_id)+input('生产数量','qty','number',sale?Math.max(0,sale.qty-S.workorders.filter(w=>w.sale_id===sale.id).reduce((a,w)=>a+w.qty,0))/1000:'',{positive:true})+input('计划完成日期','due','date',sale?.due||afterWeek())+input('工序（英文逗号分隔）','steps','text','模切,缝纫,背胶,检验',{full:true});
 }
 else if(action==='receive'){r=S.purchases.find(r=>r.id===id);data.id=id;fields=`<div class="note full">${esc(r.number)} · ${name(r.material_id)}<br>本次整单收货：${qty(r.qty)} ${esc(unit(r.material_id))}，采购金额 ${money(amount(r))}。</div>`+input('到货批次号','batch','text','',{full:true});}
 else if(action==='complete'){r=S.workorders.find(r=>r.id===id);data.id=id;fields=`<div class="note full">${esc(r.number)} · ${name(r.product_id)}<br>完工数量 ${qty(r.qty)} ${esc(unit(r.product_id))}，已领材料成本 ${money(r.material_cost)}。</div>`+input('成品批次号','batch')+input('本工单加工费用总额（元）','processing_cost','number',0,{money:true})+'<div class="note full">请汇总人工、制造及外协费用。确认代表该批次全部检验合格并入库。</div>';}
 else if(action==='issue'||action==='advance'){
  data.id=id;r=(action==='ship'?S.sales:S.workorders).find(r=>r.id===id);
  title=action==='ship'?'确认整单发货':action==='issue'?'确认生产领料':'确认工序完成';
  fields=`<div class="note full">${esc(r.number)}<br>${action==='ship'?'将按先进先出扣减全部订单数量的成品 / 贸易商品库存。':action==='issue'?'将按创建工单时的 BOM 一次性扣减原料库存。库存不足时整笔操作不执行。':`本次完成工序：${esc(JSON.parse(r.steps)[r.step])}。请确认该工序已完成。`}</div>`;
  if(action==='issue')fields+=`<div class="full">${table(['原料','需要','可用'],S.requirements.filter(l=>l.work_id===id).map(l=>tr(name(l.material_id),qty(l.qty),qty(stock(l.material_id)))))}</div>`;
 }
 else if(action==='ship'){
  title='登记整单出货';r=S.sales.find(r=>r.id===id);
  if(r)data.id=id;
  fields=(r?`<div class="note full">${esc(r.number)} · ${name(r.product_id)} · ${qty(r.qty)} ${esc(unit(r.product_id))}</div>`:select('待发货销售单','id',S.sales.filter(r=>r.status==='待发货').map(r=>[r.id,`${r.number} · ${partner(r.partner_id).name} · ${material(r.product_id).name}`])))+input('出货日期','shipped_on','date',today())+input('收货人','receiver','text','',{optional:true})+input('收货地址','address','text','',{optional:true,full:true})+input('物流公司 / 配送方式','carrier','text','',{optional:true})+input('运单号','tracking','text','',{optional:true})+input('备注','note','text','',{optional:true,full:true})+'<div class="note full">保存即确认该订单整单出货，按先进先出扣减库存，并生成出货记录。物流资料可留空。尚不支持部分出货。</div>';
 }
 else if(action==='invoice'){
  fields=select('发票类型','kind',[['销售发票','销售发票'],['采购发票','采购发票']],'销售发票')+input('发票号码','number')+select('往来单位','partner_id',partnerOptions('客户'))+select('关联订单（可选）','order_id',[],'','不关联订单')+input('开票日期','issued_on','date',today())+input('价税合计（元）','amount','number','',{money:true})+input('税额（元）','tax','number',0,{money:true})+input('备注','note','text','',{optional:true})+'<div class="note full">按实际发票填写金额及税额。关联同一订单的有效发票总额不能超过订单金额；可分多张发票登记。发票号码不能重复。</div>';
 }
 else if(action==='void_invoice'){
  r=S.invoices.find(r=>r.id===id);data.id=id;title='作废本系统发票记录';fields=`<div class="note full">发票 ${esc(r.number)} · ${money(r.amount)}<br>仅将本系统的登记记录标记为作废，原记录和日志保留，不会向税务平台提交任何操作。</div>`;
 }
 else if(action==='payment'){fields=select('类型','kind',[['收款','销售收款'],['付款','采购付款']],'收款')+select('关联单据','reference',S.sales.map(r=>[r.number,`${r.number} · 未结 ${money(amount(r)-paid('收款',r.number))}`]))+input('本次金额（元）','amount','number','',{money:true})+input('备注 / 付款方式','note','text','',{optional:true});}
 else if(action==='password'){title='修改密码';fields=input('原密码','old_password','password','',{full:true})+input('新密码（12–128 个字符）','new_password','password','',{full:true})+'<div class="note full">修改后该账号的所有登录会话立即失效，请重新登录。</div>';}
 else return;
 pendingAction={action,data};$('#modal-title').textContent=title;$('#modal-fields').innerHTML=fields;$('#form-error').textContent='';$('#modal-submit').textContent=['ship','issue','advance'].includes(action)?'确认操作':'保存';$('#modal').showModal();
 $('#modal-fields input, #modal-fields select')?.focus();
}
function trace(id){
 const lot=S.lots.find(l=>l.id===id);const direct=S.movements.filter(m=>m.material_id===lot.material_id&&m.batch===lot.batch);
 const works=new Set(direct.map(m=>m.reference).filter(ref=>S.workorders.some(w=>w.number===ref)));
 const workMoves=S.movements.filter(m=>works.has(m.reference));
 const finishedBatches=new Set(workMoves.filter(m=>m.kind==='完工入库').map(m=>`${m.material_id}/${m.batch}`));
 const all=[...new Map([...direct,...workMoves,...S.movements.filter(m=>finishedBatches.has(`${m.material_id}/${m.batch}`))].map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id);
 $('#modal-title').textContent='批次追溯';$('#modal-fields').innerHTML=`<div class="trace-box full">${name(lot.material_id)} · ${esc(lot.batch)}<br>包含此批次的直接流水、关联工单的原料与成品，以及相关成品批次的发货记录。共享原料或成品批次只表示可能关联，并非单件序列号追踪。</div><div class="full">${table(['物料 / 批次','业务','数量','单据'],all.map(m=>tr(`${name(m.material_id)}<small>${esc(m.batch)}</small>`,esc(m.kind),qty(m.qty),`<span class="mono">${esc(m.reference)}</span>`)))}</div>`;$('#form-error').textContent='';$('#modal-submit').classList.add('hidden');pendingAction=null;$('#modal').showModal();
}
function closeModal(){if(busy)return;$('#modal').close();$('#modal-submit').classList.remove('hidden');}
$('#modal-close').onclick=closeModal;$('#modal-cancel').onclick=closeModal;
$('#modal').addEventListener('cancel',e=>{if(busy)e.preventDefault();else $('#modal-submit').classList.remove('hidden');});
$('#modal-form').onsubmit=async e=>{e.preventDefault();if(!pendingAction||busy)return;busy=true;$('#modal-submit').disabled=true;$('#form-error').textContent='';const {action,data}=pendingAction;try{await api('/api/actions/'+action,{...data,...Object.fromEntries(new FormData(e.target))});busy=false;closeModal();toast('操作已保存');if(action==='password')showLogin();else await load();}catch(err){$('#form-error').textContent=err.message;}finally{busy=false;$('#modal-submit').disabled=false;}};
$('#modal-fields').addEventListener('change',e=>{
 if(pendingAction?.action==='invoice'){
  const kind=$('[name=kind]').value;
  if(e.target.name==='kind')$('[name=partner_id]').innerHTML='<option value="">请选择</option>'+partnerOptions(kind==='销售发票'?'客户':'供应商').map(([id,name])=>`<option value="${id}">${esc(name)}</option>`).join('');
  if(['kind','partner_id'].includes(e.target.name)){
   const list=(kind==='销售发票'?S.sales:S.purchases).filter(r=>r.partner_id===Number($('[name=partner_id]').value));
   $('[name=order_id]').innerHTML='<option value="">不关联订单</option>'+list.map(r=>`<option value="${r.id}">${esc(r.number)}</option>`).join('');
  }
  if(e.target.name==='order_id'){
   const id=Number(e.target.value),list=kind==='销售发票'?S.sales:S.purchases,order=list.find(r=>r.id===id);
   if(order){const invoiced=S.invoices.filter(r=>r.status==='有效'&&r.kind===kind&&(kind==='销售发票'?r.sale_id:r.purchase_id)===id).reduce((a,r)=>a+r.amount,0);$('[name=amount]').value=Math.max(0,amount(order)-invoiced)/100;}
  }
 }
 if(pendingAction?.action==='payment'&&e.target.name==='kind'){const kind=e.target.value;const list=kind==='收款'?S.sales:S.purchases;$('[name=reference]').innerHTML='<option value="">请选择</option>'+list.map(r=>`<option value="${esc(r.number)}">${esc(r.number)} · 未结 ${money(amount(r)-paid(kind,r.number))}</option>`).join('');}
 if(['sale','purchase'].includes(pendingAction?.action)&&['product_id','material_id'].includes(e.target.name)){$('[name=price]').value=(material(e.target.value).price||0)/100;}
 if(pendingAction?.action==='work'&&e.target.name==='sale_id'){const r=S.sales.find(r=>r.id===Number(e.target.value));if(r){$('[name=product_id]').value=r.product_id;$('[name=qty]').value=Math.max(0,r.qty-S.workorders.filter(w=>w.sale_id===r.id).reduce((a,w)=>a+w.qty,0))/1000;$('[name=due]').value=r.due;}}
});
$('#page').addEventListener('click',e=>{const t=e.target.closest('[data-action],[data-tab],[data-trace]');if(!t)return;if(t.dataset.tab){tab=t.dataset.tab;render();}else if(t.dataset.trace)trace(Number(t.dataset.trace));else modal(t.dataset.action,Number(t.dataset.id),t.dataset.sale==='true');});
$('#page').addEventListener('input',e=>{if(e.target.id==='search'){search=e.target.value;render();}});
$('#login-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;$('#login-error').textContent='';try{await api('/api/login',Object.fromEntries(new FormData(e.target)));e.target.reset();await load();}catch(err){$('#login-error').textContent=err.message;}finally{b.disabled=false;}};
$('#mobile-logout').onclick=$('#logout').onclick=async()=>{try{await api('/api/logout',{});showLogin();}catch(e){toast(e.message);}};
$('#password').onclick=()=>modal('password');$('#refresh').onclick=()=>load().then(()=>toast('数据已更新')).catch(e=>toast(e.message));
window.addEventListener('hashchange',route);$('#today').textContent=new Date().toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',timeZone:'Asia/Shanghai'});route();load().catch(e=>{if(e.message!=='请先登录')$('#login-error').textContent=e.message;});

$('#backup').onclick=async()=>{
 const button=$('#backup');button.disabled=true;
 try{
  const response=await fetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  if(!response.ok){const error=await response.json();throw new Error(error.error||'备份失败');}
  const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]||'erp-backup.sqlite3';
  document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  toast('备份已生成，请确认下载完成并保存到另一台设备或可信存储。');
 }catch(error){toast(error.message);}finally{button.disabled=false;}
};
