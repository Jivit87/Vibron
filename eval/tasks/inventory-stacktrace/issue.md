Crash when checking stock of an item we never stocked

Our order page crashes for new products:

```
Traceback (most recent call last):
  File "app/orders.py", line 41, in render_row
    available = inventory.count(sku)
  File "inventory/stock.py", line 19, in count
    return self._items[sku]
KeyError: 'sku-9931'
```

Expected behaviour:

- `count(sku)` for an unknown SKU returns `0`.
- `remove(sku, qty)` for an unknown SKU raises `ValueError` whose message names the SKU (today it raises `KeyError`).
- `remove` of more units than are in stock raises `ValueError` and leaves the stock unchanged (today it silently deletes the item).
