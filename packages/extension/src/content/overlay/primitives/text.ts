/**
 * F-03: the only place a caller-supplied string becomes a rendered label.
 *
 * Everything in this layer treats text as data. That is not a formality here: the values arrive
 * from a planner working over page-derived content, so a label is exactly as untrusted as the
 * text the page put in front of the model. Two properties are structural rather than a matter
 * of writing it carefully:
 *
 * 1. **No markup path exists.** There is no `innerHTML`, no `insertAdjacentHTML`, no template
 *    interpolation anywhere in the primitives, and `setLabel` is the single writer. A caller
 *    cannot opt into markup because there is no option to opt into.
 * 2. **The string is bounded before it is written.** Length, character class, and direction are
 *    all normalised, so a hostile or merely careless value cannot blow up the shadow tree.
 */

/**
 * Hard cap on rendered label length. A label is a hint beside a control, not a document; past
 * this length the extra characters are noise in the accessibility tree and in the layout, and a
 * very long string in a fixed-width bubble is how a decorative overlay becomes a performance
 * problem.
 */
export const MAX_LABEL_CHARS = 120;

/**
 * Control characters, zero-width joiners, and bidirectional overrides are stripped rather than
 * escaped. Escaping would render them as visible escape sequences, which is worse; the bidi
 * controls are stripped specifically because a label like `Visa\u202Eabc` renders as something
 * that is not what it says, which is a spoofing primitive rather than a text one.
 */
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex -- the control range is the thing being removed
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** Whitespace runs, collapsed so a caller cannot pad a label out of its bubble. */
const WHITESPACE = /\s+/g;

/**
 * Normalises an untrusted value into a short, single-line, direction-neutral string.
 *
 * Non-string input is coerced only for the primitives where that is meaningful (a badge index is
 * a number); anything else — an object, a symbol, a function — yields the empty string rather
 * than a stringified `Object.prototype`, so a mistaken field type cannot put `[object Object]`
 * or a serialized structure on a user's screen.
 */
export function sanitizeLabel(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
  else if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else return '';

  text = text.replace(UNSAFE_CHARS, ' ').replace(WHITESPACE, ' ').trim();
  if (text.length <= MAX_LABEL_CHARS) return text;
  // Cut on a code-point boundary: `slice` on a surrogate pair leaves a lone surrogate, which
  // renders as a replacement glyph.
  const cut = [...text].slice(0, MAX_LABEL_CHARS - 1).join('');
  return `${cut}…`;
}

/**
 * Writes a sanitised label into a node that already exists.
 *
 * The only writer. `textContent` cannot parse markup, and assigning the empty string releases
 * the previous text rather than leaving it attached to a node that is about to be reused.
 *
 * `changed` lets a primitive skip work that only matters when the text actually moved — a label
 * re-measuring itself on every retarget would be a layout read for a box that did not change.
 */
export function setLabel(node: HTMLElement, value: unknown): { text: string; changed: boolean } {
  const text = sanitizeLabel(value);
  if (node.textContent === text) return { text, changed: false };
  node.textContent = text;
  return { text, changed: true };
}
