"""Read-only order preparation calculations; never reserve or deduct inventory."""
from collections import defaultdict
from decimal import Decimal, ROUND_CEILING


def material_plan(materials, sales, lots, bom, prepared=()):
    catalog={row['id']:row for row in materials}
    available=defaultdict(int)
    for lot in lots:
        available[lot['material_id']]+=lot['qty']
    unallocated=available.copy()
    prepared_available=defaultdict(int)
    for row in prepared:
        prepared_available[row['product_id']]+=row['qty']
    components=defaultdict(list)
    for line in bom:
        components[line['product_id']].append(line)
    demand=defaultdict(int)
    orders=[]
    for sale in sorted((s for s in sales if s['status']=='待发货'),key=lambda s:(s['due'],s['id'])):
        product=catalog[sale['product_id']]
        stock_used=min(sale['qty'],unallocated[product['id']])
        unallocated[product['id']]-=stock_used
        shortage=sale['qty']-stock_used
        prepared_used=min(shortage,prepared_available[product['id']])
        prepared_available[product['id']]-=prepared_used
        to_prepare=shortage-prepared_used
        lines=components[product['id']]
        breakdown=[]
        missing_recipe=bool(to_prepare and product['kind']=='成品' and not lines)
        if product['kind']=='成品' and lines:
            for line in lines:
                needed=int((Decimal(to_prepare)*line['qty']/1000).to_integral_value(rounding=ROUND_CEILING))
                if needed:
                    demand[line['material_id']]+=needed
                    breakdown.append({'material_id':line['material_id'],'qty':needed})
        elif product['kind']=='贸易商品':
            demand[product['id']]+=to_prepare
        orders.append({'sale_id':sale['id'],'product_id':product['id'],'qty':sale['qty'],
                       'stock_coverage':stock_used,'shortage':shortage,'prepared_coverage':prepared_used,'to_prepare':to_prepare,'missing_recipe':missing_recipe,
                       'components':breakdown})
    summary=[]
    for key,quantity in sorted(demand.items()):
        summary.append({'material_id':key,'required':quantity,'stock':available[key],
                        'stock_shortage':max(quantity-available[key],0),
                        'purchase_suggestion':max(quantity-available[key],0)})
    return {'orders':orders,'materials':summary}
