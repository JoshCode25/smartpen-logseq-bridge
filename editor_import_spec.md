# Handwriting Editor — Import Format Specification

The editor (`/dev/editor`) accepts four distinct import formats, detected automatically at load time.

---

## Format 1 — Preferred: named stroke object

```json
{
  "slug": "my-document-slug",
  "strokes": [ ]
}
```

- `slug` — string, used as the document identifier. Optional; falls back to the filename (minus `.json`).
- `strokes` — required, non-empty array of `ProcessedStroke` (see below).

**Detection:** `parsed.strokes` is an array.

---

## Format 2 — Bare array

```json
[ ]
```

The top-level value is a JSON array of strokes. Slug defaults to the filename.

**Detection:** `Array.isArray(parsed)`.

---

## Format 3 — Chunked (NeoNote)

```json
{
  "slug": "optional-slug",
  "strokeChunks": [
    { "strokes": [ ] },
    { "strokes": [ ] }
  ]
}
```

- `strokeChunks` — array of chunk objects, each with a `strokes` array. Chunks are concatenated in order.

**Detection:** `parsed.strokeChunks` is an array.

---

## Format 4 — LogSeq markdown (`.md` files only)

A `.md` file containing one or more ` ```json ``` ` fenced code blocks. The parser expects:

- At least one block with `version` + `pageInfo` fields (metadata — contents ignored beyond detection).
- One or more blocks each with `chunkIndex: number` + `strokes: ProcessedStroke[]` (data chunks, sorted by `chunkIndex` then flattened).

Front matter `book:: N` and `page:: N` keys are used to auto-generate the slug as `bookN-pageN`.

---

## Format 5 — `HandwrittenDocument` (annotated, round-trip)

If the top-level object has `segments[]` where `segments[0].viewBox` exists, it is treated as a fully-annotated document and opens in the editor with all segment assignments restored. This is the output format of the editor itself — not an input for new raw strokes.

---

## `ProcessedStroke` object

```typescript
{
  "id": string,            // unique stroke ID, e.g. "s1766975664252"
  "startTime": number,     // unix milliseconds — used for animation ordering
  "points": [              // array of [x, y] pairs in raw pen coordinates
    [number, number],
    ...
  ],
  "pageGroup"?: string     // optional — groups strokes by page for multi-page docs
}
```

**Normalization applied at load time:**
- `id` defaults to `"s" + startTime` (or array index) if missing.
- `startTime` defaults to `0` if missing.
- Points may be `[x, y, timestamp_ms]` 3-tuples — the timestamp is silently stripped, only `[x, y]` is kept.
- Strokes are sorted ascending by `startTime` after loading.

**Coordinate space:** Raw pen units (NCode: 1 unit ≈ 2.371 mm). The importer does not rescale. If your exporter uses a different unit, apply the conversion before export.

---

## Minimal valid example (Format 1)

```json
{
  "slug": "test-page",
  "strokes": [
    {
      "id": "s1000",
      "startTime": 1000,
      "points": [[100, 200], [105, 210], [112, 225]]
    },
    {
      "id": "s2000",
      "startTime": 2000,
      "points": [[200, 200], [210, 200], [220, 200]]
    }
  ]
}
```

---

## Recommendation

Use **Format 1** (`{ slug, strokes }`) for any new exporter — it is the canonical output of `ingest-neo.js` and the most tested path. Include `id` and `startTime` on every stroke; omit `pageGroup` unless you need multi-page separation.

---

## SmartPen Logseq Bridge — Exporter output

The **JSON** and **MD** export buttons in the canvas toolbar produce files that satisfy the formats above.

### JSON export → Format 1

**Single page** (`B{book}_P{page}_strokes.json`):

```json
{
  "slug": "B3017-P42",
  "strokes": [
    { "id": "s1000", "startTime": 1000, "points": [[x, y], ...] },
    { "id": "s2000", "startTime": 2000, "points": [[x, y], ...] }
  ]
}
```

**Multi-page** (`strokes.json`) — strokes from all pages flattened, each tagged with `pageGroup`:

```json
{
  "slug": "strokes",
  "strokes": [
    { "id": "s1000", "startTime": 1000, "pageGroup": "B3017-P42", "points": [[x, y], ...] },
    { "id": "s2000", "startTime": 2000, "pageGroup": "B3017-P43", "points": [[x, y], ...] }
  ]
}
```

- Stroke ID format: `s{startTime}` (matches the bridge's internal `generateStrokeId`).
- Strokes are pre-sorted ascending by `startTime`.
- `endTime` and `blockUuid` are not included — the editor does not use them.

### MD export → Format 4

One file per page (`B{book}_P{page}_strokes.md`). All strokes for the page go into a single chunk (`chunkIndex: 0`):

```markdown
book:: 3017
page:: 42

` ``json
{"version":"1.0","pageInfo":{"section":3,"owner":1012,"book":3017,"page":42}}
` ``

` ``json
{"chunkIndex":0,"strokes":[{"id":"s1000","startTime":1000,"points":[[x,y],...]},...]}
` ``
```

- The editor generates the slug `book3017-page42` from the front-matter properties.
- Strokes are pre-sorted ascending by `startTime`.
- `endTime` and `blockUuid` are not included.
