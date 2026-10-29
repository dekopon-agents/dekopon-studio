# Policy wasm bridge

Build with `npm run build:wasm` after preparing the exact toolchain in AGENTS.md.
Rust 1.98.1, wasm-bindgen library/CLI 0.2.126, dekopon-policy 0.70.0 and Cargo.lock
are pinned. CI builds the crate and bindings; generated wasm/JS is not committed.
The build retains only the pinned glue’s initSync path and removes the unused
async URL/fetch loader, checking the expected generator shape. The app imports
only initSync and generated inline bytes. It never loads a URL.

The bridge delegates capability evaluation to PolicyEngine::authorize. Its
explicit-fact transport is internal to the bridge, not a bundle format or a
provider-inventory export. The isolated native engine test supplies fully known
synthetic facts to verify the published evaluator. Missing worlds return a gap
before parsing requests or constructing PolicyWorld. Invalid inputs return fixed
reasons rather than raw payload-derived diagnostics. HTTP-specific and pre-Cedar
broker checks are not represented as ordinary capability evaluation.

The current UI always passes no world: bundle v1 lacks the provider inventory,
including read-only membership, required by brokerd's world construction. It does
not reconstruct one from configured allowlists, observed effects, policy text,
provider pins, or transcript join lines. Successful bundle what-if evaluation is
deferred until the core export contract exists. Recorded decisions remain
authoritative; the what-if panel reports unavailability and never overwrites them.
