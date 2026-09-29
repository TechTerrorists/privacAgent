import type { TextEvidenceHints } from '../types.js';
import type { PiiClass } from '@privacagent/protocol';

export interface SemanticFixture {
  readonly id: string;
  readonly hints: TextEvidenceHints;
  readonly expectedClass: PiiClass;
  readonly expectedRule: string;
}

export interface SemanticNegativeFixture {
  readonly id: string;
  readonly hints: TextEvidenceHints;
}

export const PRECEDENCE_FIXTURES: readonly SemanticFixture[] = [
  {
    id: 'precedence-input-type-over-autocomplete',
    hints: { inputType: 'email', autocomplete: 'organization' },
    expectedClass: 'email',
    expectedRule: 'input_type:email',
  },
  {
    id: 'precedence-input-type-over-label',
    hints: { inputType: 'tel', labelKeywords: ['organization'] },
    expectedClass: 'phone',
    expectedRule: 'input_type:tel',
  },
  {
    id: 'precedence-autocomplete-over-label',
    hints: { autocomplete: 'street-address', labelKeywords: ['organization'] },
    expectedClass: 'address',
    expectedRule: 'autocomplete:street-address',
  },
  {
    id: 'precedence-password-over-everything',
    hints: { inputType: 'password', autocomplete: 'email', labelKeywords: ['organization'] },
    expectedClass: 'secret',
    expectedRule: 'input_type:password',
  },
  {
    id: 'precedence-label-only-fallback',
    hints: { labelKeywords: ['organization'] },
    expectedClass: 'organization',
    expectedRule: 'label_keyword:organization',
  },
];

export const AUTOCOMPLETE_FIXTURES: readonly SemanticFixture[] = [
  {
    id: 'autocomplete-email',
    hints: { autocomplete: 'email' },
    expectedClass: 'email',
    expectedRule: 'autocomplete:email',
  },
  {
    id: 'autocomplete-shipping-section-prefix',
    hints: { autocomplete: 'shipping street-address' },
    expectedClass: 'address',
    expectedRule: 'autocomplete:street-address',
  },
  {
    id: 'autocomplete-bday',
    hints: { autocomplete: 'bday' },
    expectedClass: 'dob',
    expectedRule: 'autocomplete:bday',
  },
  {
    id: 'autocomplete-given-name',
    hints: { autocomplete: 'given-name' },
    expectedClass: 'name',
    expectedRule: 'autocomplete:given-name',
  },
  {
    id: 'autocomplete-current-password',
    hints: { autocomplete: 'current-password' },
    expectedClass: 'secret',
    expectedRule: 'autocomplete:current-password',
  },
];

export const LABEL_KEYWORD_FIXTURES: readonly SemanticFixture[] = [
  {
    id: 'label-english-email',
    hints: { labelKeywords: ['email'] },
    expectedClass: 'email',
    expectedRule: 'label_keyword:email',
  },
  {
    id: 'label-hindi-email',
    hints: { labelKeywords: ['ईमेल'] },
    expectedClass: 'email',
    expectedRule: 'label_keyword:ईमेल',
  },
  {
    id: 'label-english-phone',
    hints: { labelKeywords: ['mobile'] },
    expectedClass: 'phone',
    expectedRule: 'label_keyword:mobile',
  },
  {
    id: 'label-hindi-phone',
    hints: { labelKeywords: ['मोबाइल'] },
    expectedClass: 'phone',
    expectedRule: 'label_keyword:मोबाइल',
  },
  {
    id: 'label-english-address',
    hints: { labelKeywords: ['pincode'] },
    expectedClass: 'address',
    expectedRule: 'label_keyword:pincode',
  },
  {
    id: 'label-hindi-address',
    hints: { labelKeywords: ['पता'] },
    expectedClass: 'address',
    expectedRule: 'label_keyword:पता',
  },
  {
    id: 'label-english-dob',
    hints: { labelKeywords: ['date of birth'] },
    expectedClass: 'dob',
    expectedRule: 'label_keyword:date of birth',
  },
  {
    id: 'label-hindi-dob',
    hints: { labelKeywords: ['जन्म तिथि'] },
    expectedClass: 'dob',
    expectedRule: 'label_keyword:जन्म तिथि',
  },
];

export const AMBIGUOUS_KEYWORD_FIXTURES: readonly SemanticFixture[] = [
  {
    id: 'ambiguous-organization-name-prefers-organization',
    hints: { labelKeywords: ['name', 'organization'] },
    expectedClass: 'organization',
    expectedRule: 'label_keyword:organization',
  },
  {
    id: 'ambiguous-name-alone-is-person-name',
    hints: { labelKeywords: ['name'] },
    expectedClass: 'name',
    expectedRule: 'label_keyword:name',
  },
  {
    id: 'ambiguous-secret-outranks-email',
    hints: { labelKeywords: ['email', 'password'] },
    expectedClass: 'secret',
    expectedRule: 'label_keyword:password',
  },
];

export const HIDDEN_AND_PASSWORD_FIXTURES: readonly SemanticFixture[] = [
  {
    id: 'hidden-field-still-classified',
    hints: { inputType: 'email' },
    expectedClass: 'email',
    expectedRule: 'input_type:email',
  },
  {
    id: 'password-field-never-resolvable-class',
    hints: { inputType: 'password' },
    expectedClass: 'secret',
    expectedRule: 'input_type:password',
  },
];

export const NEGATIVE_FIXTURES: readonly SemanticNegativeFixture[] = [
  { id: 'negative-no-hints', hints: {} },
  { id: 'negative-generic-text-input', hints: { inputType: 'text' } },
  { id: 'negative-unrecognized-autocomplete', hints: { autocomplete: 'off' } },
  { id: 'negative-unrecognized-label', hints: { labelKeywords: ['comments'] } },
  { id: 'negative-empty-label-list', hints: { labelKeywords: [] } },
];

export const ALL_SEMANTIC_FIXTURES: readonly SemanticFixture[] = [
  ...PRECEDENCE_FIXTURES,
  ...AUTOCOMPLETE_FIXTURES,
  ...LABEL_KEYWORD_FIXTURES,
  ...AMBIGUOUS_KEYWORD_FIXTURES,
  ...HIDDEN_AND_PASSWORD_FIXTURES,
];
