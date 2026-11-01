import copy
import unittest
from planning import material_plan


class PlanningTests(unittest.TestCase):
    def test_shared_stock_and_common_materials_are_not_counted_twice(self):
        materials=[{'id':1,'kind':'原材料'},{'id':2,'kind':'成品'},{'id':3,'kind':'成品'}]
        sales=[{'id':1,'product_id':2,'qty':10000,'due':'2026-12-02','status':'待发货'},
               {'id':2,'product_id':2,'qty':10000,'due':'2026-12-01','status':'待发货'},
               {'id':3,'product_id':3,'qty':5000,'due':'2026-12-03','status':'待发货'}]
        lots=[{'material_id':2,'qty':5000},{'material_id':1,'qty':2000}]
        bom=[{'product_id':2,'material_id':1,'qty':500},{'product_id':3,'material_id':1,'qty':2000}]
        original=copy.deepcopy((materials,sales,lots,bom))
        result=material_plan(materials,sales,lots,bom)
        self.assertEqual([r['sale_id'] for r in result['orders']],[2,1,3])
        self.assertEqual([r['stock_coverage'] for r in result['orders']],[5000,0,0])
        row=result['materials'][0]
        self.assertEqual(row['required'],17500)
        self.assertEqual(row['stock_shortage'],15500)
        self.assertEqual(row['purchase_suggestion'],15500)
        self.assertNotIn('incoming',row)
        self.assertEqual((materials,sales,lots,bom),original)

    def test_trade_and_missing_recipe_remain_distinct(self):
        materials=[{'id':1,'kind':'贸易商品'},{'id':2,'kind':'成品'}]
        sales=[{'id':1,'product_id':1,'qty':1000,'due':'2026-12-01','status':'待发货'},
               {'id':2,'product_id':2,'qty':1000,'due':'2026-12-01','status':'待发货'},
               {'id':3,'product_id':1,'qty':99000,'due':'2026-12-01','status':'已发货'}]
        result=material_plan(materials,sales,[],[])
        self.assertEqual(len(result['orders']),2)
        self.assertEqual(result['materials'][0]['material_id'],1)
        self.assertEqual(result['materials'][0]['required'],1000)
        self.assertTrue(result['orders'][1]['missing_recipe'])

    def test_legacy_prepared_goods_reduce_new_material_demand(self):
        materials=[{'id':1,'kind':'原材料'},{'id':2,'kind':'成品'}]
        sales=[{'id':1,'product_id':2,'qty':10000,'due':'2026-12-01','status':'待发货'}]
        result=material_plan(materials,sales,[{'material_id':2,'qty':2000}],
                             [{'product_id':2,'material_id':1,'qty':1000}],[{'product_id':2,'qty':5000}])
        self.assertEqual(result['orders'][0]['stock_coverage'],2000)
        self.assertEqual(result['orders'][0]['prepared_coverage'],5000)
        self.assertEqual(result['orders'][0]['to_prepare'],3000)
        self.assertEqual(result['materials'][0]['required'],3000)

if __name__=='__main__':
    unittest.main()
