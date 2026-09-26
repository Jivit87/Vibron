import unittest

from inventory import Inventory


class TestHiddenStock(unittest.TestCase):
    def test_count_missing_is_zero(self):
        self.assertEqual(Inventory().count("ghost"), 0)

    def test_remove_unknown_raises_value_error(self):
        with self.assertRaises(ValueError) as ctx:
            Inventory().remove("ghost", 1)
        self.assertIn("ghost", str(ctx.exception))

    def test_remove_too_many_keeps_stock(self):
        inv = Inventory()
        inv.add("apple", 2)
        with self.assertRaises(ValueError):
            inv.remove("apple", 3)
        self.assertEqual(inv.count("apple"), 2)

    def test_remove_to_zero_drops_sku(self):
        inv = Inventory()
        inv.add("apple", 2)
        inv.remove("apple", 2)
        self.assertEqual(inv.count("apple"), 0)
        self.assertEqual(inv.skus(), [])

    def test_existing_behaviour(self):
        inv = Inventory()
        inv.add("b", 1)
        inv.add("a", 1)
        self.assertEqual(inv.skus(), ["a", "b"])
        with self.assertRaises(ValueError):
            inv.add("a", 0)


if __name__ == "__main__":
    unittest.main()
