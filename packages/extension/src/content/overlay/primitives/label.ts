/**
 * F-03: the text label primitive.
 *
 * Separate from the other shapes because it is the only one with content, and content is where
 * the safety rules bite. Two of them apply specifically here:
 *
 * 1. **Text, never markup.** The string arrives from {@link setLabel} and there is no other
 *    writer, so a label cannot become an element. The primitive builds its own box in
 *    `createElement` and then writes text into it; it never parses, never interpolates into a
 *    template, and never reads anything out of the page to display.
 * 2. **Bounded twice.** The sanitiser bounds the string; the annotation cap in the core bounds how
 *    many there can be. Neither is advisory — one truncates, the other throws.
 *
 * The label is also the only primitive that has to know its own size, because a 200px bubble and
 * a 20px one are clamped very differently at a viewport edge. It is measured when the node is
 * created and when the text changes, and never per frame: a per-frame measurement would be a
 * layout read in the core's write phase, which is precisely what that phase is written to avoid.
 */
import { BasePrimitive, type BaseSpec } from './base.js';
import { setLabel } from './text.js';
import type { MarkerSize, PrimitiveSpec, PrimitiveState } from '../types.js';

/**
 * Box used for clamping until the first measurement lands, and whenever measurement is
 * unavailable. Matches the CSS so the first frame is not clamped against a wrong width.
 */
const ESTIMATED: MarkerSize = { width: 96, height: 20 };

export interface LabelSpec extends PrimitiveSpec, BaseSpec {
  readonly kind: 'label';
  /** Untrusted text. Sanitised, truncated to {@link MAX_LABEL_CHARS}, written as `textContent`. */
  readonly text?: string;
}

export class LabelPrimitive extends BasePrimitive {
  size: MarkerSize = ESTIMATED;
  private readonly text: HTMLElement;

  constructor(
    document: Document,
    spec: LabelSpec,
    context: ConstructorParameters<typeof BasePrimitive>[2]
  ) {
    super(document, 'label', context, spec.durationMs);
    // The bubble is the primitive node; the text goes in a child so the transform and the text
    // have separate boxes and a retarget cannot disturb the other's geometry.
    this.text = document.createElement('span');
    this.node.append(this.text);
    this.applyText(spec.text);
  }

  /**
   * The node is in the shadow root by the time the core calls this, which is the only moment a
   * measurement is meaningful: a detached node reports a zero box, and the estimated size would
   * then clamp the first frames against the wrong width.
   */
  override attach(): void {
    this.size = this.measure();
  }

  override retarget(spec: LabelSpec): void {
    if (this.applyText(spec.text)) this.size = this.measure();
  }

  protected override draw(state: PrimitiveState): void {
    if (!state.placement) {
      this.park();
      return;
    }
    // No glide: a text bubble that slides around is harder to read than one that is simply
    // there, and reduced-motion users get the same thing for free.
    this.place(state.placement.x, state.placement.y);
  }

  /** Returns true when the rendered text actually changed, so only then is a re-measure needed. */
  private applyText(value: unknown): boolean {
    return setLabel(this.text, value).changed;
  }

  /**
   * One layout read, on the rare path where the text changed. `offsetWidth`/`offsetHeight` are
   * used rather than `getBoundingClientRect` because they are integers and cannot be perturbed
   * by a transform — and this node carries a `translate3d(-10000px, …)` park, which a rect would
   * report as an off-screen position.
   */
  private measure(): MarkerSize {
    if (this.isReleased) return ESTIMATED;
    const width = this.node.offsetWidth;
    const height = this.node.offsetHeight;
    if (width <= 0 || height <= 0) return ESTIMATED;
    return { width, height };
  }
}
