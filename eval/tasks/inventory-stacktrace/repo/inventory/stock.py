"""In-memory stock levels keyed by SKU."""


class Inventory:
    def __init__(self):
        self._items = {}

    def add(self, sku, qty):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self._items[sku] = self._items.get(sku, 0) + qty

    def remove(self, sku, qty):
        self._items[sku] -= qty
        if self._items[sku] <= 0:
            del self._items[sku]

    def count(self, sku):
        return self._items[sku]

    def skus(self):
        return sorted(self._items)
