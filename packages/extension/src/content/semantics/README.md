# B-03 — Local accessible names and roles

This is a content-side, cooperative semantic extractor. It does not produce a sanitized
Screen State, choose an action, execute a control, determine B-04 visibility/occlusion,
read pixels, or send data. Names, descriptions, fallbacks, referenced labels and DOM handles
may contain personal information. Keep them local and pass all relevant evidence through
D-03/D-05 and the privacy pipeline before downstream serialization.

## API

- `extractSemantics(elements, options)` computes an ordered batch using a one-use index per
  Document/open ShadowRoot. The result includes scheduling metrics and local dependencies.
- `extractRegisteredTarget(registry, id, docId, options)` re-extracts an existing B-05 target
  and validates its identity again after asynchronous work.
- `walkSemanticDocument(document, registry, options)` uses the actual B-02/B-05 walk. Its
  `registered` result retains the original text and attribute evidence; enriched targets
  retain exactly the registry IDs. Detached child roots are skipped; a changed top-level
  generation invalidates the whole observation.
- `toElementRole(result)` maps no/limited role to `generic`. B-01's existing role field is
  a constrained string, not an enum; standard supported roles pass through unchanged. A
  role does not authorize an action. This function neither chooses a display name nor
  constructs a wire Element.

Each result has `role`, `roleSource`, `name`, `nameSource`, `description`,
`descriptionSource`, and a separate nullable `fallback`. An agent placeholder/alt fallback
never silently overwrites the standards-derived name. A `limited` result contains no
partial name, description, role or fallback. Consumers must re-observe or use another local
perception path; they must not treat a limit as an empty, fully examined accessible object.

## Standards and supported profile

Hand-authored fixtures cite these sources with their `standard` key:

- `accname`: [Accessible Name 1.1 §4.3.2](https://www.w3.org/TR/accname-1.1/#mapping_additional_nd_te)
  for name precedence/IDREF traversal and whitespace; [Accessible Name 1.2](https://www.w3.org/TR/accname-1.2/)
  for hidden referenced subtrees and separate descriptions. The implementation retains the
  established valid-but-empty-IDREF precedence; newer draft revisions may differ.
- `html-aam`: [HTML AAM](https://www.w3.org/TR/html-aam-1.0/), native role and name mappings.
- `aria`: [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/), concrete role tokens,
  name-from-content restrictions, prohibited names and presentation-role conflict handling.
- `agent`: intentional project policy: placeholder/non-native-alt as a separate fallback,
  and no password-value reads even when a password control is embedded in a label.

Names consider ordered, deduplicated tree-scoped `aria-labelledby`; `aria-label`; associated
explicit/wrapping/multiple HTML labels; native image/value/legend/caption/SVG title sources;
allowed rendered content; then title. Self-references may use the element's own ARIA label;
IDREF chains are not recursively followed. Missing references fall through. Descriptions use
`aria-describedby`, `aria-description`, SVG desc, then an unused title, separately from names.

Implicit roles cover native links, common input types, textarea, select, button, headings,
landmarks, lists, tables and common semantic containers. Unsupported/abstract explicit
role tokens are skipped in token order; the native role is used if no concrete role remains.
No heuristic promotes arbitrary clickable elements to buttons. A focusable element or one
with global ARIA attributes ignores `none`/`presentation` and retains native semantics.

The supported profile is deliberately not a browser accessibility-tree implementation.
It does not implement CSS pseudo-element/generated text, `aria-owns` reordering, ElementInternals
or reflected element-reference APIs, closed/UA shadow DOM, cross-origin frame contents,
platform-specific input subcontrols, localization of default submit/reset labels (English
fallbacks), or every SVG/MathML/DPub role mapping. It does not model presentational role
inheritance for all required-owned-element relationships. Native browser accessibility APIs
may differ in these cases. Open roots and slot-assigned nodes are supported. Hidden handling
is only for name computation; opacity, viewport position and occlusion belong to B-04.

## Dependencies and B-06 integration

`dependencies.nodes` includes visited text/element/ancestor nodes; `references` records
(scope, ID) pairs including currently missing IDs. `scopes` is a conservative invalidation
boundary. B-06 should invalidate results when those nodes or referenced IDs change, when
labels are added/removed/reassociated in those scopes, on slot distribution changes, and on
stylesheet/class/style/hidden changes that can alter naming. Scope invalidation is intentionally
broader than a minimum dependency graph; narrowing it later must preserve these cases.

There is no MutationObserver here and no cache across calls. B-06 owns mutation revisions
and must reject/re-run a batch if relevant DOM changes during its cooperative yields. B-05
only establishes document/node identity, not an atomic text snapshot. Callers must release
results and their live references after local processing.

The selected name does not subsume other evidence. A control may be named by `aria-label`
while its label, value, attributes and surrounding text contain different PII. The original
walker evidence is preserved independently; D-03 must inspect the appropriate native
attributes and values, not infer their absence from the selected name.

## Work bounds and checks

The existing B-02 scheduler enforces a requested budget of at most 8 ms and returns chunk,
work-unit, active-time, elapsed-time and longest-chunk metrics. Tree indexing and recursive
name traversal yield between work units. Indexes are scoped and shared across a batch;
there is no repeated full-document label search per candidate. Default limits: 20,000
semantic units per target, depth 128, 8,192 text code units, 100,000 indexed element/work units
per scope. Text/depth ceilings cannot be raised beyond 65,536/256. Browser-native operations
(style resolution, snapshotting assigned nodes, DOM APIs) cannot be preempted; measure actual
long tasks in browser fixtures rather than interpreting an 8 ms budget as a hard OS deadline.

The fixture suite contains 80 independent expected role/name cases. Unit regressions cover
limits, cancellation, no password reads, dependency invalidation and registry/evidence
composition. Browser tests run the same fixtures against Chromium and Firefox, plus scoped
roots/frames, slots and a repeated-label work benchmark. No synthetic test input establishes
privacy detector coverage or production accessibility conformance.

## Validation recorded for issue #59

Validated on the development machine in Chromium 153 and Firefox 155:

- 80 semantic fixtures in each browser; 85 semantic unit tests.
- Full root tests: 569 TypeScript tests and 313 Python tests passed. Python tests used
  a temporary isolated Redis instance, shut down after the run.
- 60 relevant browser tests passed across semantics, DOM walking and element registry.
- Root lint, typecheck, formatting, and both builds passed.
- Firefox extension lint: zero errors, 17 warnings in existing adapter/UI/ONNX bundles.
  This feature is a callable library and is not automatically invoked by the content entry.
- Repeated-label benchmark: 400 controls, 8,408 work units, cooperative chunking in both
  browsers. The initial isolated run measured longest chunks of 0.9 ms/6 ms
  (Chromium/Firefox). A later 2,000-span stress run measured a 10.4 ms Chromium chunk
  despite the 8 ms cooperative budget; native layout/GC and scheduling cannot be preempted
  within a unit. No measured semantic chunk exceeded 50 ms. These measurements are not
  proof of the 40 ms full-pipeline budget on the PRD reference laptop.

No new dependencies or wire schemas were introduced. B-06 integration still needs its own
mutation revision/observer wiring; D-03 still owns sensitive-field classification. This
feature does not make the current side-panel demo a live agent.
