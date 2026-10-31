"""Multi-file fixtures and trusted graders; graders stay outside agent Workspaces."""
TASKS = [
    {"id": "ttl-cache-contract", "files": {
        "cache.py": '''import time
class Cache:
    def __init__(self, ttl, clock=time.monotonic):
        self.ttl, self.clock, self.values = ttl, clock, {}
    def set(self, key, value):
        self.values[key] = (self.clock() + self.ttl, value)
    def get(self, key, default=None):
        entry = self.values.get(key)
        if entry is None or entry[0] < self.clock():
            return default
        return entry[1] or default
''',
        "service.py": '''def fetch_or_load(cache, key, loader):
    value = cache.get(key)
    if value is None:
        value = loader()
        cache.set(key, value)
    return value
''',
        "README.md": "Standard library only. APIs: Cache(ttl, clock), set(key,value), get(key,default=None), fetch_or_load(cache,key,loader).\n"},
     "prompt": "Fix the cache and service integration. Values expire when clock() >= expiry. Preserve cached 0, False, empty string and None: fetch_or_load must not call the loader for any unexpired cached value. Missing/expired keys return the exact default object supplied to get. Loading caches its value; overwriting refreshes expiry; TTL zero expires immediately. Keep the injectable clock, public APIs and standard library. Test both modules and boundary cases with a fake clock, without sleeps."},
    {"id": "atomic-inventory-order", "files": {
        "inventory.py": '''class Inventory:
    def __init__(self, stock):
        self.stock = dict(stock)
    def reserve(self, request):
        for sku, qty in request.items():
            if self.stock[sku] < qty:
                raise ValueError('insufficient stock')
            self.stock[sku] -= qty
''',
        "orders.py": '''def fulfill(inventory, items):
    request = {item['sku']: item['qty'] for item in items}
    inventory.reserve(request)
    return request
''',
        "README.md": "Standard library only. APIs: Inventory(stock), reserve(request), fulfill(inventory,items). Items have sku and qty; receipt is a sku-to-quantity dictionary.\n"},
     "prompt": "Fix inventory reservation and fulfillment. Every quantity must be a positive integer: booleans, zero, negatives and non-integers raise ValueError. Unknown SKUs raise KeyError; insufficient stock raises ValueError. Every failed reservation/order leaves all stock unchanged. fulfill validates every input line, sums repeated SKUs, reserves their total once, and returns that totals dictionary. Empty orders return {} unchanged. Preserve public APIs and standard library; do not mutate caller-provided stock, requests or item lists. Verify successful and failing multi-item orders."},
]

GRADERS = {
    "ttl-cache-contract": '''
Cache, fetch = load('cache').Cache, load('service').fetch_or_load
now = [10.0]
cache = Cache(5, lambda: now[0])
sentinel = object()
assert cache.get('absent', sentinel) is sentinel
for n, value in enumerate([0, False, '', None]):
    key = str(n)
    cache.set(key, value)
    actual = cache.get(key, sentinel)
    assert actual == value and type(actual) is type(value), 'Falsy value lost'
    def forbidden(): raise AssertionError('Loader called on cache hit')
    assert fetch(cache, key, forbidden) is actual
now[0] = 14.999
assert cache.get('0', sentinel) == 0
now[0] = 15.0
assert cache.get('0', sentinel) is sentinel, 'Exact expiry boundary is expired'
calls = []
def loader(): calls.append(True); return None
assert fetch(cache, 'new', loader) is None
assert fetch(cache, 'new', loader) is None
assert len(calls) == 1, 'Loaded None must be cached'
cache.set('refresh', 7)
now[0] = 18.0
cache.set('refresh', 9)
now[0] = 20.0
assert cache.get('refresh') == 9, 'Overwrite must refresh expiry'
now[0] = 23.0
assert cache.get('refresh', sentinel) is sentinel
zero = Cache(0, lambda: now[0])
zero.set('key', 1)
assert zero.get('key', sentinel) is sentinel
''',
    "atomic-inventory-order": '''
Inventory, fulfill = load('inventory').Inventory, load('orders').fulfill
def rejected(action, kind, inventory):
    before = dict(inventory.stock)
    try: action()
    except kind: pass
    else: raise AssertionError('Expected ' + kind.__name__)
    assert inventory.stock == before, 'Failure partially mutated stock'
stock = {'a':5,'b':2}
inventory = Inventory(stock)
items = [{'sku':'a','qty':2},{'sku':'a','qty':1},{'sku':'b','qty':2}]
before = copy.deepcopy(items)
assert fulfill(inventory, items) == {'a':3,'b':2}
assert inventory.stock == {'a':2,'b':0}
assert stock == {'a':5,'b':2} and items == before
assert fulfill(inventory, []) == {}
for invalid in [0,-1,True,False,1.5,'2',None]:
    inventory = Inventory({'a':5,'b':2})
    request = {'a':1,'b':invalid}
    original = dict(request)
    rejected(lambda: inventory.reserve(request), ValueError, inventory)
    assert request == original
    rejected(lambda: fulfill(inventory,[{'sku':'a','qty':invalid},{'sku':'a','qty':2}]), ValueError, inventory)
inventory = Inventory({'a':5,'b':2})
rejected(lambda: inventory.reserve({'a':1,'b':3}), ValueError, inventory)
rejected(lambda: inventory.reserve({'a':1,'missing':1}), KeyError, inventory)
rejected(lambda: fulfill(inventory,[{'sku':'a','qty':3},{'sku':'a','qty':3}]), ValueError, inventory)
rejected(lambda: fulfill(inventory,[{'sku':'a','qty':1},{'sku':'missing','qty':1}]), KeyError, inventory)
request = {'a':2,'b':1}
assert inventory.reserve(request) is None
assert request == {'a':2,'b':1} and inventory.stock == {'a':3,'b':1}
''',
}
