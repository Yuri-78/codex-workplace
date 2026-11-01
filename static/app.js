'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const qty = n => new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(n/1000);
const money = n => '¥'+new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n/100);
const amount = r => Math.round(r.qty*r.price/1000);
const today = () => new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
const afterWeek = () => {const d=new Date();d.setDate(d.getDate()+7);return d.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});};
const pages = [['dashboard','◫','经营概览'],['sales','▤','销售订单'],['shipments','⇥','出货记录'],['invoices','▧','发票记录'],['preparation','▥','备料管理'],['statements','≷','月度对账'],['purchases','⇣','采购管理'],['receipts','⇤','收货记录'],['inventory','▦','库存与批次'],['finance','◈','收支与成本'],['master','⊞','基础资料'],['audit','≡','操作记录']];
let recordFilters={part:'',from:'',to:'',basis:'issued_on',settlement:'全部'};
let S, current='dashboard', tab='', search='', busy=false;
const material = id => S.materials.find(r=>r.id===Number(id)) || {};
const partner = id => S.partners.find(r=>r.id===Number(id)) || {};
const stock = id => S.lots.filter(r=>r.material_id===id).reduce((a,r)=>a+r.qty,0);
const unit = id => material(id).unit || '';
const name = id => esc(material(id).name || '—');
const pName = id => esc(partner(id).name || '—');
const paid = (kind,ref) => S.payments.filter(p=>p.kind===kind && p.reference===ref).reduce((a,r)=>a+r.amount,0);
const can = action => S.user.role==='管理' || ({业务:['sale','purchase','partner','payment','invoice','void_invoice','invoice_details','invoice_payment','statement_create','statement_confirm'],仓库:['opening','receive','ship','attachment','finished_receive'],生产:['finished_receive'],备料:['finished_receive']}[S.user.role]||[]).includes(action);
function btn(action,label,id,extra=''){return can(action)?`<button data-action="${action}" ${id?`data-id="${id}"`:''} ${extra}>${label}</button>`:'';}
function badge(status){const cl=({'已发货':'green','已收货':'green','已确认':'green','待确认':'warn','待发货':'warn','待收货':'warn'})[status]||'';return `<span class="pill ${cl}">${esc(status)}</span>`;}
function table(headers,rows,empty='暂无记录，点击右上角按钮开始录入'){return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>{let index=0;return row.replace(/<td>/g,()=>`<td data-label="${esc(headers[index++]||'')}">`);}).join(''):`<tr><td colspan="${headers.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;}
const tr = (...cells)=>`<tr>${cells.map(c=>`<td>${c}</td>`).join('')}</tr>`;
function panel(title,body,right=''){return `<section class="panel"><div class="panel-head"><h2>${title}</h2>${right}</div>${body}</section>`;}
function heading(en,title,description,action,label){return `<div class="page-heading"><div><span class="eyebrow">${en}</span><h1>${title}</h1><p>${description}</p></div>${action&&can(action)?`<button class="primary" data-action="${action}">＋ ${label}</button>`:''}</div>`;}
function stat(label,value,hint,icon='↗',accent=false){return `<div class="stat ${accent?'accent':''}"><div class="stat-label">${label}<b>${icon}</b></div><div class="stat-value">${value}</div><small>${hint}</small></div>`;}
function toolbar(tabs){return `<div class="toolbar"><div class="tabs">${tabs.map(t=>`<button data-tab="${t}" class="${tab===t?'active':''}">${t}</button>`).join('')}</div><input id="search" class="search" type="search" placeholder="搜索编号、名称、批次…" aria-label="搜索" value="${esc(search)}"></div>`;}
function match(...values){return !search || values.some(v=>String(v??'').toLowerCase().includes(search.toLowerCase()));}
function salesRows(list,compact=false){return list.map(r=>tr(`<strong class="mono">${esc(r.number)}</strong><small>${pName(r.partner_id)}</small>`,`${name(r.product_id)}<small>${material(r.product_id).kind} · ${qty(r.qty)} ${esc(unit(r.product_id))}</small>`,money(amount(r)),`<span class="${r.due<today()&&r.status!=='已发货'?'ledger-negative':''}">${esc(r.due)}</span>`,badge(r.status),compact?'':`<div class="row-actions">${r.status==='待发货'?btn('ship','确认发货',r.id):''}</div>`));}
function dashboard(){
 const orders=S.sales.filter(r=>r.status==='待发货'), needs=S.preparation.orders.filter(r=>r.to_prepare>0);
 const low=S.materials.filter(m=>stock(m.id)<m.min_qty);
 const value=S.lots.reduce((a,r)=>a+Math.round(r.qty*r.unit_cost/1000),0);
 const sales=S.sales.filter(r=>r.status==='已发货').reduce((a,r)=>a+amount(r),0);
 const cogs=-S.movements.filter(r=>r.kind==='销售出库').reduce((a,r)=>a+r.amount,0);
 return heading('BUSINESS OVERVIEW','经营概览','订单有进度，库存有依据，经营心中有数。')+
 `<div class="cards">${stat('待交付订单',orders.length,`订单金额 ${money(orders.reduce((a,r)=>a+amount(r),0))}`,'▤',true)}${stat('需备料订单',needs.length,'先抵扣成品，再计算原料缺口','▥')}${stat('当前库存货值',money(value),`${low.length} 项物料低于安全库存`,'▦')}${stat('已发货毛利',money(sales-cogs),'销售收入 − 批次出库成本（未计税费）','↗')}</div>`+
 `<div class="grid-two">${panel('近期交付订单 <small>按交期排序</small>',table(['订单 / 客户','产品 / 数量','订单金额','交付日期','状态',''],salesRows([...orders].sort((a,b)=>a.due.localeCompare(b.due)).slice(0,5),true)),' <a class="link" href="#sales">全部订单 →</a>')}${panel('库存预警',low.length?`<div class="warning-list">${low.slice(0,5).map(m=>`<div class="warning-item"><span class="warning-icon">!</span><div><strong>${esc(m.name)}</strong><small>现存 ${qty(stock(m.id))} / 安全库存 ${qty(m.min_qty)} ${esc(m.unit)}</small></div><span class="pill warn">需补充</span></div>`).join('')}</div>`:'<div class="empty">库存充足，暂无预警</div>','<a class="link" href="#inventory">查看库存 →</a>')}</div>`+
 `<div class="grid-two">${panel('备料提醒',table(['零件','订单需求','库存覆盖','新增备料缺口'],needs.slice(0,4).map(r=>tr(name(r.product_id),qty(r.qty),qty(r.stock_coverage),`<span class="pill warn">${qty(r.to_prepare)} ${esc(unit(r.product_id))}</span>`)),'所有待发货订单均有库存覆盖'),'<a class="link" href="#preparation">查看备料 →</a>')}${panel('最近业务记录',table(['业务','操作人','时间'],S.audit.slice(0,5).map(r=>tr(`${esc(actionNames[r.action]||r.action)}<small class="mono">${esc(r.reference)}</small>`,esc(r.actor),dateTime(r.created)))))}</div>`;
}
const actionNames={material:'新增物料',partner:'新增往来单位',bom:'维护物料用量',opening:'期初入库',sale:'新建销售单',purchase:'新建采购单',receive:'采购收货',work:'新建生产单',issue:'生产领料',advance:'工序报工',complete:'完工入库',ship:'登记出货',invoice:'登记发票',void_invoice:'作废发票记录',backup:'下载数据库备份',finished_receive:'成品入库',statement_create:'生成对账单',statement_confirm:'确认对账',invoice_details:'修改发票计划',invoice_payment:'登记发票收付款',attachment:'保存单据照片',payment:'登记收付款',password:'修改密码',reset_password:'管理员重置密码'};
const dateTime=s=>esc(new Date(s).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Asia/Shanghai'}));
function salesPage(){
 const list=S.sales.filter(r=>(tab==='全部'||r.status===tab)&&match(r.number,material(r.product_id).name,partner(r.partner_id).name));
 return heading('SALES ORDERS','销售订单','自产产品与代理商品统一接单，按交期跟踪交付。','sale','新增销售单')+toolbar(['全部','待发货','已发货'])+panel('订单列表',table(['订单 / 客户','产品 / 数量','订单金额','交付日期','状态','操作'],salesRows(list)));
}
function preparationPage(){
 const plan=S.preparation,rows=plan.orders.filter(r=>match(material(r.product_id).name,S.sales.find(o=>o.id===r.sale_id)?.number));
 return heading('MATERIAL PREPARATION','备料管理','先核对成品库存，再计算不足部分的原料需求；做好后只登记成品入库。','finished_receive','登记成品入库')+`<div class="note">按交期、订单编号依次抵扣现有成品，每份库存只计算一次。以下只按已入库库存计算，不预留或扣减库存；采购下单不提前抵扣缺口，实际收货后更新。实际入库时按当前物料用量表扣料，库存不足则整笔不执行。${S.legacy_materials.length?'<br>有历史已扣料记录待入库，已单独抵扣需求；请在成品入库时选择原记录，避免重复扣料。':''}</div>`+toolbar([])+panel('成品 / 商品需求',table(['订单 / 交期','零件','订单数量','成品库存覆盖','历史已备待入库','新增备料缺口','提示'],rows.map(r=>{const sale=S.sales.find(o=>o.id===r.sale_id);return tr(`<strong class="mono">${esc(sale.number)}</strong><small>${esc(sale.due)} · ${pName(sale.partner_id)}</small>`,name(r.product_id),`${qty(r.qty)} ${esc(unit(r.product_id))}`,qty(r.stock_coverage),qty(r.prepared_coverage),qty(r.to_prepare),r.missing_recipe?'<span class="pill warn">需补物料用量表</span>':material(r.product_id).kind==='贸易商品'?'按商品数量采购':r.to_prepare?'已换算原料用量':'无需新增备料');})))+panel('原料 / 商品缺口汇总',table(['物料','订单所需','现有库存','缺口','建议采购'],plan.materials.filter(r=>match(material(r.material_id).name)).map(r=>tr(name(r.material_id),`${qty(r.required)} ${esc(unit(r.material_id))}`,qty(r.stock),qty(r.stock_shortage),`<span class="pill ${r.purchase_suggestion?'warn':'green'}">${qty(r.purchase_suggestion)}</span>`)),'暂无需准备的原料或商品'))+panel('成品入库记录',table(['入库单 / 日期','成品 / 数量','批次','材料成本','加工费用','总成本 / 经办人'],S.finished_receipts.filter(r=>match(r.number,r.batch,material(r.product_id).name)).map(r=>tr(`<strong class="mono">${esc(r.number)}</strong><small>${esc(r.received_on)}</small>`,`${name(r.product_id)}<small>${qty(r.qty)} ${esc(unit(r.product_id))}</small>`,esc(r.batch),money(r.material_cost),money(r.processing_cost),`${money(r.material_cost+r.processing_cost)}<small>${esc(r.actor)}</small>`))))+panel('历史已备料待入库',table(['历史编号','成品','数量','已扣材料成本'],S.legacy_materials.map(r=>tr(esc(r.number),name(r.product_id),qty(r.qty),money(r.material_cost))),'无历史待处理记录'));
}
function statementPage(){
 const rows=S.statements.filter(r=>match(r.number,partner(r.partner_id).name,r.from_date,r.to_date));
 return heading('MONTHLY RECONCILIATION','月度对账','按客户和日期汇总发货，核对确认后再选择发货单登记发票。','statement_create','生成客户对账单')+'<div class="note">每张发货单只进入一份对账单；晚录入的发货可另生成补充对账单。金额按订单单价快照汇总，不自动向客户发送。发票关联不代表已足额开票，请核对实际金额。</div>'+toolbar([])+panel('客户对账单',table(['对账单 / 客户','日期范围','金额','状态','发货 / 关联发票','操作'],rows.map(r=>{const lines=S.statement_lines.filter(l=>l.statement_id===r.id);const linked=lines.filter(l=>S.invoice_shipments.some(x=>x.shipment_id===l.shipment_id&&S.invoices.some(i=>i.id===x.invoice_id&&i.status==='有效')));return tr(`<strong class="mono">${esc(r.number)}</strong><small>${pName(r.partner_id)}</small>`,`${esc(r.from_date)}<small>至 ${esc(r.to_date)}</small>`,money(r.amount),badge(r.status),`${lines.length} 张发货<small>${linked.length} 张已关联有效发票</small>`,`<div class="row-actions"><button data-statement-detail="${r.id}">明细 / 打印</button>${r.status==='待确认'?btn('statement_confirm','确认对账',r.id):linked.length<lines.length?btn('invoice','登记发票',r.id,'data-statement="true"'):''}</div>`);})));
}
function showStatement(id){const record=S.statements.find(r=>r.id===id);const lines=S.statement_lines.filter(r=>r.statement_id===id);$('#modal-title').textContent='客户发货对账单';$('#modal-fields').innerHTML=`<div class="note full">${pName(record.partner_id)} · ${esc(record.number)}<br>${esc(record.from_date)} 至 ${esc(record.to_date)} · ${esc(record.status)}<br>合计 ${money(record.amount)}</div><div class="full">${table(['发货日期 / 单号','零件','数量','单价','金额'],lines.map(r=>{const ship=S.shipments.find(h=>h.id===r.shipment_id);return tr(`${esc(ship.shipped_on)}<small>${esc(ship.number)}</small>`,name(r.product_id),`${qty(r.qty)} ${esc(unit(r.product_id))}`,money(r.price),money(r.amount));}))}</div><button type="button" class="quiet full" id="print-statement">打印 / 另存 PDF</button>`;$('#form-error').textContent='';$('#modal-submit').classList.add('hidden');pendingAction=null;$('#modal').showModal();$('#print-statement').onclick=()=>{document.body.classList.add('printing-statement');window.print();};}
window.addEventListener('afterprint',()=>document.body.classList.remove('printing-statement'));
function purchasePage(){const list=S.purchases.filter(r=>(tab==='全部'||r.status===tab)&&match(r.number,material(r.material_id).name,partner(r.partner_id).name));return heading('PURCHASING','采购管理','采购原材料用于生产，采购贸易商品直接销售。','purchase','新增采购单')+toolbar(['全部','待收货','已收货'])+panel('采购订单',table(['采购单 / 供应商','物料 / 类型','数量','采购金额','状态','操作'],list.map(r=>tr(`<strong class="mono">${esc(r.number)}</strong><small>${pName(r.partner_id)}</small>`,`${name(r.material_id)}<small>${esc(material(r.material_id).kind)}</small>`,`${qty(r.qty)} ${esc(unit(r.material_id))}`,money(amount(r)),badge(r.status),`<div class="row-actions">${r.status==='待收货'?btn('receive','收货入库',r.id):''}</div>`))));}
function rangeIncludes(value,from,to){return (!from&&!to)||Boolean(value&&(!from||value>=from)&&(!to||value<=to));}
function invoiceState(r){const verb=r.kind==='销售发票'?'收款':'付款';return r.settled_amount===0?'未'+verb:r.settled_amount>=r.amount?'已'+verb:'部分'+verb;}
function filterBar(invoice=false){return `<form id="record-filter-form" class="record-filters"><label>零件名称<input name="part" value="${esc(recordFilters.part)}" placeholder="输入全部或部分名称"></label>${invoice?select('筛选日期','basis',[['issued_on','开票日期'],['planned_on','计划收付款日期'],['last_paid_on','最近收付款日期']],recordFilters.basis):''}<label>起始日期（含当天）<input type="date" name="from" value="${esc(recordFilters.from)}"></label><label>结束日期（含当天）<input type="date" name="to" value="${esc(recordFilters.to)}"></label>${invoice?select('收付款状态','settlement',['全部','未收款','部分收款','已收款','未付款','部分付款','已付款'].map(x=>[x,x]),recordFilters.settlement):''}<div class="filter-actions"><button class="primary" type="submit">筛选</button><button class="quiet" type="button" data-reset-filters>重置</button></div><div class="error filter-error" id="filter-error" role="alert"></div></form>`;}
function photoButton(kind,id){const column=kind==='shipments'?'shipment_id':'receipt_id';const count=S.attachments.filter(a=>a[column]===id).length;return `<div class="row-actions"><button data-photos="${id}" data-record-kind="${kind}">照片 (${count})</button></div>`;}
function shipmentPage(){
 const rows=S.shipments.filter(h=>{const sale=S.sales.find(r=>r.id===h.sale_id)||{};return match(h.number,sale.number,partner(sale.partner_id).name,h.receiver,h.carrier,h.tracking,material(sale.product_id).name)&&String(material(sale.product_id).name||'').includes(recordFilters.part)&&rangeIncludes(h.shipped_on,recordFilters.from,recordFilters.to);});
 return heading('SHIPMENT RECORDS','出货记录','按零件和出货日期筛选，可保存发货单照片；目前按销售单整单出货。','ship','登记出货')+filterBar()+toolbar([])+panel('出货台账',table(['出货单 / 销售单','客户 / 收货信息','零件 / 数量','出货日期','物流 / 运单号','出库批次','备注 / 照片'],rows.map(h=>{const sale=S.sales.find(r=>r.id===h.sale_id)||{};const moves=S.movements.filter(m=>m.reference===sale.number&&m.kind==='销售出库');return tr(`<strong class="mono">${esc(h.number)}</strong><small>${esc(sale.number)}</small>`,`${pName(sale.partner_id)}<small>${esc(h.receiver||'未填写')} · ${esc(h.address)}</small>`,`${name(sale.product_id)}<small>${qty(sale.qty)} ${esc(unit(sale.product_id))}</small>`,esc(h.shipped_on||'历史日期未知'),`${esc(h.carrier||'未填写')}<small class="mono">${esc(h.tracking)}</small>`,moves.map(m=>`<span class="mono">${esc(m.batch)}</span><small>${qty(-m.qty)} ${esc(unit(m.material_id))}</small>`).join(''),`${esc(h.note)}<small>${esc(h.actor)}</small>${photoButton('shipments',h.id)}`);})));
}
function receiptPage(){
 const rows=S.receipts.filter(h=>{const order=S.purchases.find(r=>r.id===h.purchase_id)||{};return match(h.number,order.number,partner(order.partner_id).name,material(order.material_id).name)&&String(material(order.material_id).name||'').includes(recordFilters.part)&&rangeIncludes(h.received_on,recordFilters.from,recordFilters.to);});
 return heading('RECEIPT RECORDS','收货记录','采购收货后自动生成收货单，可保存签收单或实物照片。')+filterBar()+toolbar([])+panel('收货台账',table(['收货单 / 采购单','供应商','零件 / 数量','收货日期','备注 / 经办人','照片附件'],rows.map(h=>{const order=S.purchases.find(r=>r.id===h.purchase_id)||{};return tr(`<strong class="mono">${esc(h.number)}</strong><small>${esc(order.number)}</small>`,pName(order.partner_id),`${name(order.material_id)}<small>${qty(order.qty)} ${esc(unit(order.material_id))}</small>`,esc(h.received_on||'历史日期未知'),`${esc(h.note)}<small>${esc(h.actor)}</small>`,photoButton('receipts',h.id));})));
}
function backupNotice(){const info=S.monthly_backup;if(!info)return '';return `<div class="note ${info.error?'backup-error':''}">每月自动备份：${info.error?'失败，需处理：'+esc(info.error):info.current_exists?'本月备份已保存':'等待本月首次备份'}。最近文件：${esc(info.latest||'暂无')}。<br>位置：${esc(info.folder)}。程序运行时每分钟检查；关闭后下次启动补做当前月份。不补造历史月份，不自动删除旧备份，同一硬盘损坏仍可能丢失，请另存一份。</div>`;}
function invoicePage(){
 const kind=tab==='开出的发票'?'销售发票':tab==='收到的发票'?'采购发票':'';
 const records=S.invoices.filter(r=>(!kind||r.kind===kind)&&match(r.number,partner(r.partner_id).name,r.note,r.part_name)&&String(r.part_name).includes(recordFilters.part)&&rangeIncludes(r[recordFilters.basis],recordFilters.from,recordFilters.to)&&(recordFilters.settlement==='全部'||(r.status==='有效'&&invoiceState(r)===recordFilters.settlement)));
 const valid=records.filter(r=>r.status==='有效');
 return heading('INVOICE REGISTER','发票记录','区分开票与收票，按发票跟踪计划日期、实际收付款和未结余额。','invoice','登记发票')+`<div class="note">开出的发票跟踪收款，收到的发票跟踪付款。可关联同一客户的多张发货单，不要求关联订单。零件名称可填写多个名称；仅记录真实发票，不提供税务开票。已有资金流水请关联原记录，避免重复记账。</div>`+backupNotice()+filterBar(true)+toolbar(['全部','开出的发票','收到的发票'])+`<div class="cards">${stat('筛选内开票金额',money(valid.filter(r=>r.kind==='销售发票').reduce((a,r)=>a+r.amount,0)),'有效记录 · 价税合计','▧',true)}${stat('筛选内收票金额',money(valid.filter(r=>r.kind==='采购发票').reduce((a,r)=>a+r.amount,0)),'有效记录 · 价税合计','▧')}${stat('未收余额',money(valid.filter(r=>r.kind==='销售发票').reduce((a,r)=>a+r.amount-r.settled_amount,0)),'筛选内有效开票','↙')}${stat('未付余额',money(valid.filter(r=>r.kind==='采购发票').reduce((a,r)=>a+r.amount-r.settled_amount,0)),'筛选内有效收票','↗')}</div>`+panel('发票台账',table(['发票单号 / 方向','往来单位','零件 / 发货单','开票日期','开票金额 / 税额','计划收付款日期','收付款状态 / 余额','操作'],records.map(r=>{const links=S.invoice_shipments.filter(x=>x.invoice_id===r.id).map(x=>S.shipments.find(h=>h.id===x.shipment_id)?.number).filter(Boolean);const overdue=r.status==='有效'&&r.settled_amount<r.amount&&r.planned_on&&r.planned_on<today();return tr(`<strong class="mono">${esc(r.number)}</strong><small>${r.kind==='销售发票'?'开出的发票':'收到的发票'} · ${esc(r.status)}</small>`,`${pName(r.partner_id)}<small>${esc(r.note)}</small>`,`${esc(r.part_name||'历史零件未填写')}<small class="mono">${esc(links.join(' / ')||'未关联发货单')}</small>`,esc(r.issued_on),`${money(r.amount)}<small>税额 ${money(r.tax)} · 不含税 ${money(r.amount-r.tax)}</small>`,`${esc(r.planned_on||'未填写')}${overdue?'<small class="ledger-negative">已逾期</small>':''}`,`${badge(r.status==='作废'?'作废':invoiceState(r))}<small>已结 ${money(r.settled_amount)} / 未结 ${money(r.amount-r.settled_amount)}</small><small>最近收付款 ${esc(r.last_paid_on||'—')}</small>`,`<div class="row-actions"><button data-invoice-history="${r.id}">收付款明细</button>${r.status==='有效'?btn('invoice_details','修改计划',r.id)+(r.settled_amount<r.amount?btn('invoice_payment',r.kind==='销售发票'?'登记收款':'登记付款',r.id):'')+(r.settled_amount===0?btn('void_invoice','作废记录',r.id):''):''}</div>`);})));
}
function showInvoiceHistory(id){const invoice=S.invoices.find(r=>r.id===id);const rows=S.payments.filter(p=>p.invoice_id===id);$('#modal-title').textContent='发票收付款明细';$('#modal-fields').innerHTML=`<div class="note full">${esc(invoice.number)} · 开票 ${money(invoice.amount)} · 已结 ${money(invoice.settled_amount)}</div><div class="full">${table(['实际日期','类型','金额','备注 / 经办人'],rows.map(p=>tr(esc(p.paid_on||'历史日期未填写'),esc(p.kind),money(p.amount),`${esc(p.note)}<small>${esc(p.actor)}</small>`)),'暂无关联的收付款记录')}</div>`;$('#form-error').textContent='';$('#modal-submit').classList.add('hidden');pendingAction=null;$('#modal').showModal();}
function shipmentSelector(partnerId,selected=[]){const list=S.shipments.filter(h=>S.sales.find(o=>o.id===h.sale_id)?.partner_id===Number(partnerId));return `<label class="full">关联发货单（可多选；按住 Ctrl 选择多张）<select name="shipment_ids" multiple size="4">${list.map(h=>{const order=S.sales.find(o=>o.id===h.sale_id);return `<option value="${h.id}" ${selected.includes(h.id)?'selected':''}>${esc(h.number)} · ${esc(material(order.product_id).name)} · ${esc(h.shipped_on)}</option>`;}).join('')}</select><small>不选择也可登记；同一张发货单可关联多张发票，不自动分摊发票金额。</small></label>`;}
function showPhotos(kind,id){const column=kind==='shipments'?'shipment_id':'receipt_id';const photos=S.attachments.filter(p=>p[column]===id);$('#modal-title').textContent=(kind==='shipments'?'发货单':'收货单')+'照片附件';$('#modal-fields').innerHTML=`<div class="note full">每张单据最多 10 张照片，每张最大 8 MB，支持 JPG、PNG、WebP。照片保存在数据库中，随备份保存。</div><div class="photo-gallery full">${photos.length?photos.map(p=>`<a href="/api/attachments/${p.id}" target="_blank" rel="noopener"><img src="/api/attachments/${p.id}" alt="${esc(p.filename)}"><span>${esc(p.filename)}</span><small>${(p.size/1024).toFixed(0)} KB · ${esc(p.actor)}</small></a>`).join(''):'<p class="empty">尚无照片附件</p>'}</div>${can('attachment')?`<button type="button" class="primary full" id="upload-photo">拍照 / 选择照片上传</button>`:''}`;$('#form-error').textContent='';$('#modal-submit').classList.add('hidden');pendingAction=null;$('#modal').showModal();if($('#upload-photo'))$('#upload-photo').onclick=()=>{closeModal();modal('attachment',id,false,kind);};}
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
 else body=table(['时间','类型','关联单据','金额','备注','操作人'],S.payments.filter(r=>match(r.reference,r.note,r.kind)).map(r=>tr(`${esc(r.paid_on||'历史日期未填写')}<small>登记 ${dateTime(r.created)}</small>`,badge(r.kind),`<span class="mono">${esc(r.reference)}</span>`,money(r.amount),esc(r.note),esc(r.actor))));
 return heading('CASHFLOW & COST','收支与成本','按单登记收付款，追踪自产和贸易的实际出库成本。','payment','登记收付款')+`<div class="cards">${stat('销售未结余额',money(receive),'含未发货订单，按合同总额计算','↙',true)}${stat('采购未结余额',money(pay),'含未收货订单，按合同总额计算','↗')}${stat('累计收款',money(S.payments.filter(r=>r.kind==='收款').reduce((a,r)=>a+r.amount,0)),'按手工登记记录汇总','＋')}${stat('累计付款',money(S.payments.filter(r=>r.kind==='付款').reduce((a,r)=>a+r.amount,0)),'按手工登记记录汇总','−')}</div><div class="note">成本为简化管理口径：原材料按批次成本计价，加工费用在成品入库时汇总登记；未包含税务核算、费用分摊或总账。每单位入库成本保留至分，可能产生舍入差异。</div>`+panel('已发货毛利 <small>按业务类型区分 · 全部期间</small>',table(['业务类型','销售收入','实际出库成本','毛利（未计税费）'],['成品','贸易商品'].map(kind=>{const sales=S.sales.filter(r=>r.status==='已发货'&&material(r.product_id).kind===kind);const refs=new Set(sales.map(r=>r.number));const revenue=sales.reduce((a,r)=>a+amount(r),0);const cogs=-S.movements.filter(m=>m.kind==='销售出库'&&refs.has(m.reference)).reduce((a,m)=>a+m.amount,0);return tr(kind==='成品'?'自产产品':'代理贸易',money(revenue),money(cogs),money(revenue-cogs));})))+toolbar(['订单结算','收付款流水'])+panel(tab,body);
}
function masterPage(){
 let body,action,label;
 if(tab==='物料与商品'){action='material';label='新增物料';body=table(['编码','名称','类型','单位','安全库存','参考单价'],S.materials.filter(r=>match(r.code,r.name,r.kind)).map(r=>tr(`<span class="mono">${esc(r.code)}</span>`,esc(r.name),badge(r.kind),esc(r.unit),qty(r.min_qty),money(r.price))));}
 else if(tab==='往来单位'){action='partner';label='新增往来单位';body=table(['名称','类型','联系人 / 备注'],S.partners.filter(r=>match(r.name,r.kind,r.contact)).map(r=>tr(esc(r.name),badge(r.kind),esc(r.contact))));}
 else{action='bom';label='维护物料用量';body='<div class="total-line">用量 = 1 单位成品需要的原料数量。用于备料测算及成品入库扣料；调整后影响后续入库，历史流水不变。</div>'+table(['成品','原材料','每单位用量'],S.bom.filter(r=>match(material(r.product_id).name,material(r.material_id).name)).map(r=>tr(name(r.product_id),name(r.material_id),`${qty(r.qty)} ${esc(unit(r.material_id))}`)));}
 return heading('MASTER DATA','基础资料','维护自产成品、贸易商品及原材料，统一业务数据来源。',action,label)+toolbar(['物料与商品','往来单位','物料用量表'])+panel(tab,body);
}
function auditPage(){return heading('ACTIVITY LOG','操作记录','关键业务动作保留操作人、时间及关联单据。')+toolbar([])+panel('业务操作日志',table(['时间','操作人','操作','关联单据'],S.audit.filter(r=>match(r.actor,r.action,r.reference,actionNames[r.action])).map(r=>tr(dateTime(r.created),esc(r.actor),esc(actionNames[r.action]||r.action),`<span class="mono">${esc(r.reference)}</span>`))));}
function render(){
 const focus=$('#search')===document.activeElement, caret=focus?$('#search').selectionStart:0;
 $('#page').innerHTML=({dashboard,sales:salesPage,shipments:shipmentPage,invoices:invoicePage,preparation:preparationPage,statements:statementPage,purchases:purchasePage,receipts:receiptPage,inventory:inventoryPage,finance:financePage,master:masterPage,audit:auditPage}[current])();
 $('#crumb').textContent=pages.find(p=>p[0]===current)[2];
 $('#nav').innerHTML=pages.map(([id,icon,title])=>`<a href="#${id}" class="${current===id?'active':''}"><span class="nav-icon">${icon}</span>${title}</a>`).join('');
 if(focus&&$('#search')){$('#search').focus();try{$('#search').setSelectionRange(caret,caret);}catch{}}
}
function route(){recordFilters={part:'',from:'',to:'',basis:'issued_on',settlement:'全部'};current=location.hash.slice(1);if(!pages.some(p=>p[0]===current))current='dashboard';search='';tab=({sales:'全部',invoices:'全部',purchases:'全部',inventory:'库存余额',finance:'订单结算',master:'物料与商品'})[current]||'';if(S)render();}
async function api(path,data){const response=await fetch(path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const body=await response.json();if(!response.ok){if(response.status===401)showLogin();throw new Error(body.error||'请求失败');}return body;}
function showLogin(){$('#shell').classList.add('hidden');$('#login').classList.remove('hidden');S=null;}
async function load(){S=await api('/api/state');$('#login').classList.add('hidden');$('#shell').classList.remove('hidden');$('#backup').classList.toggle('hidden',S.user.role!=='管理');$('#user-name').textContent=S.user.name;$('#user-role').textContent=(S.user.role==='生产'?'备料':S.user.role)+'账号';$('#avatar').textContent=S.user.name[0];$('#demo-banner').classList.toggle('hidden',!S.demo);render();}
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),4000);}
function input(label,key,type='text',value='',opts={}){return `<label class="${opts.full?'full':''}">${label}<input name="${key}" type="${type}" value="${esc(value)}" ${opts.optional?'':'required'} ${type==='number'?`min="${opts.positive?'0.001':'0'}" step="${opts.money?'0.01':'0.001'}" max="100000000"`:''} ${type==='password'?'autocomplete="off"':''} ${opts.maxlength?`maxlength="${opts.maxlength}"`:''}></label>`;}
function select(label,key,options,selected='',optional=false){return `<label>${label}<select name="${key}" ${optional?'':'required'}><option value="">${optional?esc(typeof optional==='string'?optional:'不关联（备货）'):'请选择'}</option>${options.map(([v,t])=>`<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;}
function materialOptions(kinds){return S.materials.filter(m=>kinds.includes(m.kind)).map(m=>[m.id,`${m.code} · ${m.name}（${m.unit}）`]);}
function partnerOptions(kind){return S.partners.filter(p=>p.kind===kind).map(p=>[p.id,p.name]);}
let pendingAction;
function modal(action,id,forSale=false,recordKind=''){
 let title=actionNames[action]||'',fields='',data={},r;
 const q=input('数量','qty','number','',{positive:true});
 const price=input('单价（元 / 单位）','price','number','',{money:true});
 if(action==='material'){fields=input('物料编码','code')+input('名称','name')+select('类型','kind',['原材料','成品','贸易商品'].map(x=>[x,x]))+input('计量单位','unit','text','件')+input('安全库存','min_qty','number',0)+input('参考单价（元）','price','number',0,{money:true});}
 else if(action==='partner')fields=input('单位名称','name')+select('类型','kind',['客户','供应商'].map(x=>[x,x]))+input('联系人 / 备注','contact','text','',{optional:true,full:true});
 else if(action==='bom')fields=select('成品','product_id',materialOptions(['成品']))+select('原材料','material_id',materialOptions(['原材料']))+input('每 1 单位成品的用量','qty','number','',{positive:true})+'<div class="note full">已有成品与原材料组合会更新用量。已建工单用量不会改变。</div>';
 else if(action==='opening')fields=select('物料','material_id',materialOptions(['原材料','成品','贸易商品']))+input('批次号','batch')+q+input('单位成本（元）','price','number','',{money:true})+'<div class="note full">仅用于首次上线前现有库存建账。日常采购请通过采购单收货。</div>';
 else if(action==='sale'||action==='purchase'){const sale=action==='sale';fields=select(sale?'客户':'供应商','partner_id',partnerOptions(sale?'客户':'供应商'))+select(sale?'销售产品':'采购物料',sale?'product_id':'material_id',materialOptions(sale?['成品','贸易商品']:['原材料','贸易商品']))+q+price+(sale?input('交付日期','due','date',afterWeek()):'');}
 else if(action==='finished_receive'){
  fields=select('自产成品','product_id',materialOptions(['成品']))+input('成品数量','qty','number','',{positive:true})+input('入库日期','received_on','date',today())+input('成品批次号','batch')+input('加工费用总额（元，可填 0）','processing_cost','number',0,{money:true})+select('历史已扣料记录（仅历史数据）','legacy_work_id',S.legacy_materials.map(w=>[w.id,`${w.number} · ${material(w.product_id).name} · ${qty(w.qty)}`]),'','无，按用量表扣料')+input('备注','note','text','',{optional:true,full:true})+'<div class="note full">只登记一次成品入库，不建工单。按物料用量表扣减原料，计算材料及加工成本，再增加成品库存。选择历史已扣料记录时不会再次扣原料。库存不足或批次重复时整笔不执行。</div>';
 }
 else if(action==='statement_create'){
  title='生成客户对账单';fields=select('客户','partner_id',partnerOptions('客户'))+input('起始日期','from_date','date',today().slice(0,8)+'01')+input('结束日期','to_date','date',today())+'<div class="note full">收集此客户在起止日期（含当天）内、尚未进入其他对账单的发货记录。生成后保留金额快照，可查看明细并打印。</div>';
 }
 else if(action==='statement_confirm'){
  r=S.statements.find(r=>r.id===id);data.id=id;title='确认客户对账';fields=`<div class="note full">${pName(r.partner_id)} · ${esc(r.number)} · ${money(r.amount)}<br>请在与客户核对无误后确认。仅记录人工核对结果，不会自动发送消息或开票。</div>`;
 }
 else if(action==='receive'){r=S.purchases.find(r=>r.id===id);data.id=id;fields=`<div class="note full">${esc(r.number)} · ${name(r.material_id)}<br>本次整单收货：${qty(r.qty)} ${esc(unit(r.material_id))}，采购金额 ${money(amount(r))}。</div>`+input('到货批次号','batch','text','',{full:true});}
 else if(action==='ship'){
  title='登记整单出货';r=S.sales.find(r=>r.id===id);
  if(r)data.id=id;
  fields=(r?`<div class="note full">${esc(r.number)} · ${name(r.product_id)} · ${qty(r.qty)} ${esc(unit(r.product_id))}</div>`:select('待发货销售单','id',S.sales.filter(r=>r.status==='待发货').map(r=>[r.id,`${r.number} · ${partner(r.partner_id).name} · ${material(r.product_id).name}`])))+input('出货日期','shipped_on','date',today())+input('收货人','receiver','text','',{optional:true})+input('收货地址','address','text','',{optional:true,full:true})+input('物流公司 / 配送方式','carrier','text','',{optional:true})+input('运单号','tracking','text','',{optional:true})+input('备注','note','text','',{optional:true,full:true})+'<div class="note full">保存即确认该订单整单出货，按先进先出扣减库存，并生成出货记录。物流资料可留空。尚不支持部分出货。</div>';
 }
 else if(action==='invoice'){
  fields=select('发票方向','kind',[['销售发票','开出的发票（收款）'],['采购发票','收到的发票（付款）']],'销售发票')+input('发票单号','number')+select('客户 / 供应商','partner_id',partnerOptions('客户'))+input('零件名称（多个名称可用逗号分隔）','part_name')+input('开票日期','issued_on','date',today())+input('计划收款 / 付款日期','planned_on','date',afterWeek())+input('开票金额（价税合计，元）','amount','number','',{money:true})+input('税额（元）','tax','number',0,{money:true})+shipmentSelector(null)+input('备注','note','text','',{optional:true,full:true});
 }
 else if(action==='invoice_details'){
  r=S.invoices.find(r=>r.id===id);data.id=id;fields=`<div class="note full">${esc(r.number)} · ${r.kind==='销售发票'?'计划收款':'计划付款'}</div>`+input('零件名称','part_name','text',r.part_name)+input('计划收款 / 付款日期','planned_on','date',r.planned_on)+(r.kind==='销售发票'?shipmentSelector(r.partner_id,S.invoice_shipments.filter(x=>x.invoice_id===id).map(x=>x.shipment_id)):'');
 }
 else if(action==='invoice_payment'){
  r=S.invoices.find(r=>r.id===id);data.id=id;const verb=r.kind==='销售发票'?'收款':'付款';title='登记'+verb;
  const order=(r.sale_id?S.sales:S.purchases).find(o=>o.id===(r.sale_id||r.purchase_id));const reference=order?.number||'INV:'+r.number;
  const existing=S.payments.filter(p=>p.invoice_id===null&&p.reference===reference&&p.kind===verb);
  fields=`<div class="note full">${esc(r.number)} · ${pName(r.partner_id)}<br>开票金额 ${money(r.amount)} · 未结余额 ${money(r.amount-r.settled_amount)}</div>`+select('关联已登记资金流水（可选）','existing_payment_id',existing.map(p=>[p.id,`${money(p.amount)} · ${p.paid_on||'历史日期未填'} · ${p.note}`]),'','新增收付款记录')+input('本次'+verb+'金额（元）','amount','number',(r.amount-r.settled_amount)/100,{money:true})+input('实际'+verb+'日期','paid_on','date',today())+input('备注','note','text','',{optional:true})+'<div class="note full">选择已有流水时会使用原流水金额，只建立关联，不重复新增资金流水。支持分次收付款；状态根据已结金额自动更新。</div>';
 }
 else if(action==='attachment'){
  data={record_kind:recordKind,record_id:id};title='保存单据照片';fields='<label class="full">拍照或选择一张照片<input type="file" name="photo" accept="image/jpeg,image/png,image/webp" capture="environment" required></label><div class="note full">每张最大 8 MB；支持 JPG、PNG、WebP，不支持 HEIC。保存后请在单据的“照片”中确认。</div>';
 }
 else if(action==='void_invoice'){
  r=S.invoices.find(r=>r.id===id);data.id=id;title='作废本系统发票记录';fields=`<div class="note full">发票 ${esc(r.number)} · ${money(r.amount)}<br>仅将本系统的登记记录标记为作废，原记录和日志保留，不会向税务平台提交任何操作。</div>`;
 }
 else if(action==='payment'){fields=select('类型','kind',[['收款','销售收款'],['付款','采购付款']],'收款')+select('关联单据','reference',S.sales.map(r=>[r.number,`${r.number} · 未结 ${money(amount(r)-paid('收款',r.number))}`]))+input('本次金额（元）','amount','number','',{money:true})+input('实际收付款日期','paid_on','date',today())+input('备注 / 付款方式','note','text','',{optional:true});}
 else if(action==='password'){title='修改密码';fields=input('原密码','old_password','password','',{full:true})+input('新密码（12–128 个字符）','new_password','password','',{full:true})+'<div class="note full">修改后该账号的所有登录会话立即失效，请重新登录。</div>';}
 else return;
 if(action==='invoice'&&forSale){
  const statement=S.statements.find(r=>r.id===id);
  const lines=S.statement_lines.filter(l=>l.statement_id===id&&!S.invoice_shipments.some(x=>x.shipment_id===l.shipment_id&&S.invoices.some(i=>i.id===x.invoice_id&&i.status==='有效')));
  if(statement?.status==='已确认'&&lines.length){
   const doc=new DOMParser().parseFromString('<form>'+fields+'</form>','text/html');const form=doc.querySelector('form');
   form.querySelector('[name=partner_id]').innerHTML=partnerOptions('客户').map(([key,name])=>`<option value="${key}" ${key===statement.partner_id?'selected':''}>${esc(name)}</option>`).join('');
   form.querySelector('[name=shipment_ids]').closest('label').outerHTML=shipmentSelector(statement.partner_id,lines.map(l=>l.shipment_id));
   form.querySelector('[name=part_name]').setAttribute('value',[...new Set(lines.map(l=>material(l.product_id).name))].join(', '));
   form.querySelector('[name=amount]').setAttribute('value',lines.reduce((a,l)=>a+l.amount,0)/100);
   fields=form.innerHTML;
  }
 }
 pendingAction={action,data};$('#modal-title').textContent=title;$('#modal-fields').innerHTML=fields;$('#form-error').textContent='';$('#modal-submit').textContent=['ship','statement_confirm'].includes(action)?'确认操作':'保存';$('#modal').showModal();
 $('#modal-fields input, #modal-fields select')?.focus();
}
function trace(id){
 const lot=S.lots.find(l=>l.id===id);const direct=S.movements.filter(m=>m.material_id===lot.material_id&&m.batch===lot.batch);
 const works=new Set(direct.filter(m=>['成品用料','成品入库','生产领料','完工入库'].includes(m.kind)).map(m=>m.reference));
 for(const f of S.finished_receipts){if(works.has(f.number)&&f.legacy_reference)works.add(f.legacy_reference);if(works.has(f.legacy_reference))works.add(f.number);}
 const workMoves=S.movements.filter(m=>works.has(m.reference));
 const finishedBatches=new Set(workMoves.filter(m=>['完工入库','成品入库'].includes(m.kind)).map(m=>`${m.material_id}/${m.batch}`));
 const all=[...new Map([...direct,...workMoves,...S.movements.filter(m=>finishedBatches.has(`${m.material_id}/${m.batch}`))].map(m=>[m.id,m])).values()].sort((a,b)=>a.id-b.id);
 $('#modal-title').textContent='批次追溯';$('#modal-fields').innerHTML=`<div class="trace-box full">${name(lot.material_id)} · ${esc(lot.batch)}<br>包含此批次的直接流水、关联入库的原料与成品，以及相关成品批次的发货记录。共享原料或成品批次只表示可能关联，并非单件序列号追踪。</div><div class="full">${table(['物料 / 批次','业务','数量','单据'],all.map(m=>tr(`${name(m.material_id)}<small>${esc(m.batch)}</small>`,esc(m.kind),qty(m.qty),`<span class="mono">${esc(m.reference)}</span>`)))}</div>`;$('#form-error').textContent='';$('#modal-submit').classList.add('hidden');pendingAction=null;$('#modal').showModal();
}
function closeModal(){if(busy)return;$('#modal').close();$('#modal-submit').classList.remove('hidden');}
$('#modal-close').onclick=closeModal;$('#modal-cancel').onclick=closeModal;
$('#modal').addEventListener('cancel',e=>{if(busy)e.preventDefault();else $('#modal-submit').classList.remove('hidden');});
$('#modal-form').onsubmit=async e=>{e.preventDefault();if(!pendingAction||busy)return;busy=true;$('#modal-submit').disabled=true;$('#form-error').textContent='';const {action,data}=pendingAction;try{const form=new FormData(e.target);let payload={...data,...Object.fromEntries(form)};
 if(['invoice','invoice_details'].includes(action)&&form.has('shipment_ids'))payload.shipment_ids=form.getAll('shipment_ids');
 else if(['invoice','invoice_details'].includes(action)&&$('[name=shipment_ids]'))payload.shipment_ids=[];
 if(action==='attachment'){
  const file=form.get('photo');if(!file||file.size===0||file.size>8*1024*1024)throw new Error('请选择一张不超过 8 MB 的照片');
  payload={...data,filename:file.name,content:await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('照片读取失败'));reader.readAsDataURL(file);})};
 }
 await api('/api/actions/'+action,payload);busy=false;closeModal();toast('操作已保存');if(action==='password')showLogin();else await load();}catch(err){$('#form-error').textContent=err.message;}finally{busy=false;$('#modal-submit').disabled=false;}};
$('#modal-fields').addEventListener('change',e=>{
 if(pendingAction?.action==='invoice'){
  const kind=$('[name=kind]').value;
  if(e.target.name==='kind'){
   $('[name=partner_id]').innerHTML='<option value="">请选择</option>'+partnerOptions(kind==='销售发票'?'客户':'供应商').map(([id,name])=>`<option value="${id}">${esc(name)}</option>`).join('');
  }
  if(['kind','partner_id'].includes(e.target.name)){
   const label=$('[name=shipment_ids]').closest('label');label.outerHTML=shipmentSelector(kind==='销售发票'?$('[name=partner_id]').value:null);$('[name=shipment_ids]').disabled=kind!=='销售发票';
  }
  if(e.target.name==='shipment_ids'){
   const ids=[...e.target.selectedOptions].map(o=>Number(o.value));const parts=[...new Set(ids.map(id=>{const h=S.shipments.find(h=>h.id===id);return material(S.sales.find(o=>o.id===h.sale_id).product_id).name;}))];
   if(parts.length)$('[name=part_name]').value=parts.join(', ');
  }
 }
 if(pendingAction?.action==='invoice_payment'&&e.target.name==='existing_payment_id'){
  const p=S.payments.find(p=>p.id===Number(e.target.value));$('[name=amount]').readOnly=Boolean(p);if(p){$('[name=amount]').value=p.amount/100;if(p.paid_on)$('[name=paid_on]').value=p.paid_on;}
 }
 if(pendingAction?.action==='finished_receive'&&e.target.name==='legacy_work_id'){const item=S.legacy_materials.find(w=>w.id===Number(e.target.value));if(item){$('[name=product_id]').value=item.product_id;$('[name=qty]').value=item.qty/1000;}}
 if(pendingAction?.action==='payment'&&e.target.name==='kind'){const kind=e.target.value;const list=kind==='收款'?S.sales:S.purchases;$('[name=reference]').innerHTML='<option value="">请选择</option>'+list.map(r=>`<option value="${esc(r.number)}">${esc(r.number)} · 未结 ${money(amount(r)-paid(kind,r.number))}</option>`).join('');}
 if(['sale','purchase'].includes(pendingAction?.action)&&['product_id','material_id'].includes(e.target.name)){$('[name=price]').value=(material(e.target.value).price||0)/100;}

});
$('#page').addEventListener('click',e=>{const t=e.target.closest('[data-action],[data-tab],[data-trace],[data-photos],[data-invoice-history],[data-statement-detail],[data-reset-filters]');if(!t)return;if(t.hasAttribute('data-reset-filters')){recordFilters={part:'',from:'',to:'',basis:'issued_on',settlement:'全部'};render();return;}if(t.dataset.statementDetail){showStatement(Number(t.dataset.statementDetail));return;}if(t.dataset.invoiceHistory){showInvoiceHistory(Number(t.dataset.invoiceHistory));return;}if(t.dataset.photos){showPhotos(t.dataset.recordKind,Number(t.dataset.photos));return;}if(t.dataset.tab){tab=t.dataset.tab;render();}else if(t.dataset.trace)trace(Number(t.dataset.trace));else modal(t.dataset.action,Number(t.dataset.id),t.dataset.statement==='true');});
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

$('#page').addEventListener('submit',e=>{
 if(e.target.id!=='record-filter-form')return;e.preventDefault();const values=Object.fromEntries(new FormData(e.target));
 if(values.from&&values.to&&values.from>values.to){$('#filter-error').textContent='起始日期不能晚于结束日期';return;}
 recordFilters={...recordFilters,...values};render();
});
