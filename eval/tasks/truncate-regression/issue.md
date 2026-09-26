truncate() output is longer than the limit; also allow a custom ellipsis

`truncate(text, max)` is documented to return at most `max` characters, but the ellipsis is appended *after* cutting to `max`:

```js
truncate("abcdefghij", 5) // "abcde..." (8 chars), expected "ab..." (5 chars)
```

Please:

1. Make sure the result (ellipsis included) is never longer than `max`.
2. Add an options argument `truncate(text, max, { ellipsis })` so callers can use e.g. `"…"`. The default stays `"..."`.

Keep the existing behaviour of cutting at a word boundary when there is one.
