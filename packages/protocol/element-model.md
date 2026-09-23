# Element model (B-01)

B-01 verifies and completes the element contract introduced in E-01. The authoritative
definition remains [protocol.schema.json](schemas/protocol.schema.json). TypeScript types,
browser validators and Python models are generated from that schema; consumers must not
maintain another wire model in the extension or server.

## Requirement mapping

| B-01 requirement | Shared contract                                                                            | Verification                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Element          | `Element`: display, empty, filled and redacted variants                                    | `full-screen` and `b01-element-catalog` valid fixtures; TypeScript value-variant narrowing test                                   |
| bbox             | `BBox`, a four-number `[x, y, width, height]` tuple in TypeScript                          | Catalog includes fractional and off-screen coordinates; malformed length, negative width/height and non-JSON numbers are rejected |
| state            | `ElementState`, optional observed boolean flags                                            | Catalog covers every state flag; malformed values, unknown properties and explicit nulls are rejected                             |
| src              | `Element['src']` in TypeScript; the generated `src` literal union on Python element models | Catalog covers `dom`, `vision`, `fused` and `server_vlm`; missing and unknown sources are rejected                                |
| doc_id           | `DocumentId` on the enclosing `ScreenState`                                                | Required document fixture checks, typed consumer tests and rejection of per-element `doc_id`                                      |
| Test fixtures    | Shared [valid](fixtures/valid.json) and [invalid](fixtures/invalid.json) message corpora   | Both language suites, browser-validator sandbox and TypeScript → Python → TypeScript round trips                                  |

E-01 already provided the base types and value variants. B-01 adds the PRD's missing
`state.invalid` and `state.occluded` flags, element-focused examples and rejection cases,
and this consumer handoff. It does not implement page observation or execution.

## Identity and geometry

An element ID is meaningful only together with its observation's `doc_id`. `e*` identifies
a DOM-backed element; `v*` identifies a vision-only element. The existing schema accepts
an alphanumeric/underscore/hyphen suffix, not only numeric IDs. Do not infer a tab,
permission or global identity from the spelling.

Keep the document identity when passing an element to another component. Navigation or
a SPA route change requires a new document identity, maintained by B-05. The executor's
freshness checks also need the observation ID (B-15). Schema validation checks the shape
of these identifiers; it cannot establish that an element still exists or is current.

Element boxes use **page CSS pixels**, in `[x, y, width, height]` order. Fractional and
negative positions are valid; width and height cannot be negative. A box outside the
viewport can describe an off-screen target. Zero-size boxes are structurally valid;
B-04 is responsible for visibility filtering. These are not screenshot/device pixels
or raw viewport-relative `getBoundingClientRect()` coordinates. A-08 owns conversions,
including scroll, zoom, DPR and frame offsets. Crop-region boxes use crop pixels and
must not be interpreted as element boxes.

`src` describes how the interaction description was obtained. A DOM-backed target can
have `src: 'fused'`; merging evidence does not turn it into a vision-only target. Keep
DOM/vision identity distinct from provenance. `conf` is a finite number from 0 to 1;
the schema permits the endpoints but does not decide whether confidence is sufficient
to execute an action or authorize image escalation.

## State and values

`state` is optional. Each supplied flag must be a boolean:

| Flag                                                                             | Meaning / producer                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `disabled`, `checked`, `selected`, `expanded`, `required`, `readonly`, `focused` | Observed control state, extracted through DOM/accessibility semantics                             |
| `invalid`                                                                        | The control is reported invalid by DOM/accessibility semantics; B-03 defines the extraction rules |
| `occluded`                                                                       | The B-04 occlusion check found another element covering the target                                |

Omitted flags are unknown or not applicable. They must not be defaulted to `false`.
An omitted state, `{}`, and `{ "disabled": false }` are distinct valid representations;
explicit `null` is invalid. `invalid` and `occluded` belong in the wire state because
they help a planner interpret a control and avoid a covered target. Raw validation
messages, DOM nodes and occluding-node details remain local evidence.

| Element variant | Value fields                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------- |
| Display-only    | Omit `value_state`, `value` and `pii_class`; e.g. a button or checkbox described by its state |
| Empty input     | `value_state: 'empty'` and `value: ''`                                                        |
| Filled input    | `value_state: 'filled'` and a nonempty value that has passed local privacy processing         |
| Redacted input  | `value_state: 'redacted'`, a supported placeholder and `pii_class`                            |

A display-only element is not evidence of an empty input. A placeholder describes a
withheld value; it is not permission to resolve it. `{{SECRET}}` remains non-resolvable
by the executor. Schema validity does not establish that any name, value or label is
safe to send.

## Consumer examples

The TypeScript types are exported from the package root. Derive the source type from
`Element` rather than copying its allowed strings:

```ts
import {
  parseMessage,
  type BBox,
  type DocumentId,
  type Element,
  type ElementState,
} from '@privacagent/protocol';

function firstTarget(decodedJson: unknown) {
  const observation = parseMessage('ScreenState', decodedJson);
  // A diff is not a complete page; E-08 owns state reconstruction.
  if (observation.kind !== 'full') return undefined;
  const element: Element | undefined = observation.elements[0];
  if (!element) return undefined;

  const docId: DocumentId = observation.doc_id;
  const bbox: BBox = element.bbox;
  const source: Element['src'] = element.src;
  const state: ElementState | undefined = element.state;
  return { docId, observationId: observation.observation_id, element, bbox, source, state };
}
```

This returns document context for a consumer, not a new wire message or execution
authorization. Validate an element as part of its Screen State using the existing
public boundary; there is no separate element-parser API.

Python consumers use the same boundary before accessing generated model fields:

```python
from privacagent_protocol import models, parse_message

def first_target(decoded_json):
    observation = parse_message("ScreenState", decoded_json).root
    if observation.kind != "full" or not observation.elements:
        return None
    element: models.Element = observation.elements[0]
    return {
        "doc_id": observation.doc_id.root,
        "observation_id": observation.observation_id,
        "element": element.model_dump(mode="json", exclude_unset=True),
    }
```

Generated scalar/union models may use `.root`. Use `model_dump(mode='json',
exclude_unset=True)` when preparing JSON so absent optional flags do not become nulls.
For a complete synthetic observation see `b01-element-catalog` in the shared valid
fixtures; `b01-element-state-diff` illustrates changed invalid/occluded state.

## Handoff boundaries

- **B-02/B-03:** extract local evidence and compute semantic roles, names and states.
  Native tags, attributes such as `autocomplete`, raw values and DOM references belong
  in local-only structures, not extra fields on the wire `Element`.
- **B-04/B-05:** compute visibility/occlusion and maintain the registry/document lifecycle.
  This model defines neither algorithms nor an element lookup service.
- **C-01/C-10 and D-01:** keep DOM text, DOM attributes and OCR evidence separate even
  when their interaction-map elements are fused. The privacy engine scans those sources
  independently before producing outbound-facing fields. Do not discard OCR evidence
  because a DOM name is already present.
- **F-02:** consume document-scoped IDs and boxes through the future registry/coordinate
  interfaces. Do not persist an ID across documents or treat an overlay as approval UI.

The model does not perform redaction, detector-coverage checks, placeholder binding,
freshness checks or network transmission. Those remain mandatory downstream boundaries.

## Compatibility and verification

The protocol is still the initial unpublished `1.0` contract. B-01 keeps that version
while completing the scaffold; all existing valid messages remain valid. However,
older strict validators **reject** the newly supplied `invalid`/`occluded` fields.
Client and server owners must update their schema/generated files together before
emitting them. This is not a mixed-version deployment compatibility guarantee; a
published protocol change must follow the versioning policy in the package README.

For schema changes, run `pnpm protocol:generate`, then `pnpm protocol:check`,
`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check` and `pnpm build` from the
repository root. The shared fixtures run through both language validators and the
cross-language round trip. Existing E-01 cases continue to cover redaction metadata,
raw-field rejection, missing document context, value variants and element-count limits.
