import unittest

from inventory import Inventory


class TestStock(unittest.TestCase):
    def test_add_and_count(self):
        inv = Inventory()
        inv.add("apple", 3)
        inv.add("apple", 2)
        self.assertEqual(inv.count("apple"), 5)

    def test_remove(self):
        inv = Inventory()
        inv.add("pear", 4)
        inv.remove("pear", 1)
        self.assertEqual(inv.count("pear"), 3)


if __name__ == "__main__":
    unittest.main()
