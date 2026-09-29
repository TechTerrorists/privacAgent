/** Concrete WAI-ARIA 1.2 roles. Abstract/unknown tokens are not roles. */
const ROLES = new Set(
  `alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem`.split(
    ' '
  )
);
export const CONTENT_NAMES = new Set(
  `button cell checkbox columnheader gridcell heading link menuitem menuitemcheckbox menuitemradio option radio row rowheader switch tab tooltip treeitem`.split(
    ' '
  )
);
export const PROHIBITED_NAMES = new Set(
  `caption code deletion emphasis generic insertion none paragraph presentation strong subscript superscript`.split(
    ' '
  )
);
const NATIVE: Record<string, string> = {
  button: 'button',
  textarea: 'textbox',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  article: 'article',
  dialog: 'dialog',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  td: 'cell',
  thead: 'rowgroup',
  tbody: 'rowgroup',
  tfoot: 'rowgroup',
  progress: 'progressbar',
  meter: 'meter',
  fieldset: 'group',
  figure: 'figure',
  output: 'status',
  option: 'option',
  optgroup: 'group',
  hr: 'separator',
  p: 'paragraph',
  blockquote: 'blockquote',
  details: 'group',
  summary: 'button',
  svg: 'img',
};
export function inputType(node: Element): string {
  return (node as HTMLInputElement).type;
}
export function labelable(node: Element): boolean {
  return (
    ['button', 'meter', 'output', 'progress', 'select', 'textarea'].includes(node.localName) ||
    (node.localName === 'input' && inputType(node) !== 'hidden')
  );
}
export function implicitRole(node: Element): string | null {
  const tag = node.localName;
  if (tag === 'a' || tag === 'area') return node.hasAttribute('href') ? 'link' : null;
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'img')
    return node.getAttribute('alt') === '' &&
      !node.hasAttribute('aria-label') &&
      !node.hasAttribute('aria-labelledby') &&
      !node.hasAttribute('title') &&
      !node.hasAttribute('tabindex')
      ? 'presentation'
      : 'img';
  if (tag === 'select')
    return (node as HTMLSelectElement).multiple ||
      Number.parseInt(node.getAttribute('size') ?? '0', 10) > 1
      ? 'listbox'
      : 'combobox';
  if (tag === 'input') {
    const type = inputType(node);
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (['checkbox', 'radio'].includes(type)) return type;
    if (type === 'range') return 'slider';
    if (type === 'number') return 'spinbutton';
    if (['email', 'tel', 'text', 'url', 'search'].includes(type))
      return node.hasAttribute('list') &&
        (node.getRootNode() as Document | ShadowRoot).getElementById(node.getAttribute('list')!)
          ?.localName === 'datalist'
        ? 'combobox'
        : type === 'search'
          ? 'searchbox'
          : 'textbox';
    return null;
  }
  if (tag === 'header' || tag === 'footer') {
    // Caller bounds ancestor depth before role resolution.
    if (node.parentElement?.closest('article,aside,main,nav,section')) return null;
    return tag === 'header' ? 'banner' : 'contentinfo';
  }
  if (tag === 'section' || tag === 'form')
    return node.hasAttribute('aria-label') ||
      node.hasAttribute('aria-labelledby') ||
      node.hasAttribute('title')
      ? tag === 'section'
        ? 'region'
        : 'form'
      : null;
  if (tag === 'th')
    return node.getAttribute('scope') === 'row' || node.getAttribute('scope') === 'rowgroup'
      ? 'rowheader'
      : 'columnheader';
  return NATIVE[tag] ?? null;
}
export function roleOf(node: Element): {
  role: string | null;
  roleSource: 'explicit' | 'implicit' | 'none';
} {
  const token = (node.getAttribute('role') ?? '')
    .split(/[\t\n\f\r ]+/)
    .find((role) => ROLES.has(role));
  if (token) {
    const presentational = token === 'none' || token === 'presentation';
    const focusable =
      node.hasAttribute('tabindex') ||
      (['a', 'area'].includes(node.localName) && node.hasAttribute('href')) ||
      (['button', 'input', 'select', 'textarea', 'summary'].includes(node.localName) &&
        !node.hasAttribute('disabled') &&
        !(node.localName === 'input' && inputType(node) === 'hidden')) ||
      node.hasAttribute('contenteditable');
    const globalAria = [
      'atomic',
      'busy',
      'controls',
      'current',
      'describedby',
      'description',
      'details',
      'disabled',
      'dropeffect',
      'errormessage',
      'flowto',
      'grabbed',
      'haspopup',
      'hidden',
      'invalid',
      'keyshortcuts',
      'label',
      'labelledby',
      'live',
      'owns',
      'relevant',
      'roledescription',
    ].some((a) => node.hasAttribute(`aria-${a}`));
    if (!presentational || (!focusable && !globalAria))
      return { role: token, roleSource: 'explicit' };
  }
  const role = implicitRole(node);
  return { role, roleSource: role === null ? 'none' : 'implicit' };
}
