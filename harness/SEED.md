# Frozen seed, version 1

R10's seed is a captured trial bundle plus ordered continuation messages. The
Studio downloads one UTF-8 JSON file, `dekopon-seed-v1.json`. This envelope is
separate from [bundle v1](BUNDLE.md): the embedded `manifest.json` and referenced
files remain byte-for-byte unchanged, including the manifest's null `seedDigest`.

```json
{"seedVersion":1,"files":[{"path":"manifest.json","base64":"…"}],"continuationMessages":[{"text":"Continue from the frozen conversation."}]}
```

| Field | Contract |
| --- | --- |
| `seedVersion` | Integer `1`; other versions are refused. |
| `files` | Objects with `path` and `base64`. Include `manifest.json` and every present file reachable through its validated bundle-v1 references, once per path. Never include unreferenced siblings. Missing referenced files remain gaps except for the frozen journals required below. Paths follow bundle-v1 safety rules: relative, slash-separated, no empty, `.` or `..` segments, backslash, colon or NUL. Text must be valid Unicode. Bytes use standard RFC 4648 base64 with canonical padding and pad bits, no whitespace. |
| `continuationMessages` | Ordered objects `{ "text": <Unicode string> }`, the harness scenario's message shape. Text is preserved exactly, including empty strings and line breaks. An empty array is valid; it schedules no further messages. Text supplies no authority. |

Only a bundle whose reader validates the captured non-null `freeze` can be
exported or imported as a seed. `manifest.journal` must be non-null, and every
`freeze.journalStems` entry must have a present, integrity-verified
`journal/<stem>.jsonl` reference in `manifest.journal.files`. An unavailable frozen
journal is a `seed-freeze` error, not an allowed missing-evidence gap.
Marking selects that existing freeze; a timeline
cursor cannot create an earlier journal snapshot. Identity, conversation, grants,
configuration and policy remain the embedded bundle's. Evidence gaps and
incompleteness remain visible; seed validity does not assert a trial is scorable.
Import recovers the file map and delegates integrity and record reconstruction to
`readTrialBundle`. Duplicate/unsafe paths, unreferenced files, invalid base64,
malformed fields/continuations and unavailable freezes are errors. Unknown fields
are noted and their values discarded by the reader; source bytes remain in the
private file map solely for re-export. An attachment's `source` is never rendered.

Producers serialize compact JSON without BOM, trailing newline or insignificant
whitespace. Root field order is `seedVersion`, `files`, `continuationMessages`;
file field order is `path`, `base64`; continuation field order is `text`. Sort file
paths lexicographically by unsigned UTF-8 bytes (shorter equal prefix first),
without Unicode normalization. Strings use ECMAScript `JSON.stringify` escaping.
This makes repeated exports of the same bytes and texts stable. Readers need not
require producer ordering or whitespace: the digest always identifies actual bytes.

`seedDigest` is lowercase hexadecimal SHA-256 of the **exact downloaded bytes**,
computed locally. It is displayed beside the download, never embedded in the file
it hashes. Consumers hash the original bytes, not a reserialized JSON object.
A future trial can carry this value only under its approved manifest contract;
bundle v1's fixed-null rule is unchanged. `evalgw/branch-arms` consumes this
envelope directly, restores the frozen bundle, then sends continuations in array
order under R9. Transport/session limits are the runner's validation, not seed
text normalization. Editing a journal, timestamp, pin or grant is a different
experiment, not an unchanged seed.

The browser retains bytes locally and exports only after an explicit button
press through a temporary Blob download URL, revoked after download initiation.
No upload, fetch, remote import, telemetry, worker or server participates. Only
synthetic fixtures belong in repository tests.
