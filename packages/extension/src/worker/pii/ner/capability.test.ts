import { describe, expect, it } from 'vitest';

import { meetsCoverageThreshold, RECALL_TARGET, RUN3_NER_CAPABILITY } from './capability.js';

describe('RUN3_NER_CAPABILITY', () => {
  it('records the real measured recall, far below the coverage target', () => {
    expect(RUN3_NER_CAPABILITY.measuredMicroRecall).toBeLessThan(RECALL_TARGET);
  });

  it('does not meet the coverage threshold', () => {
    expect(meetsCoverageThreshold(RUN3_NER_CAPABILITY)).toBe(false);
  });
});

describe('meetsCoverageThreshold', () => {
  it('is true only at or above the target', () => {
    expect(meetsCoverageThreshold({ ...RUN3_NER_CAPABILITY, measuredMicroRecall: 0.98 })).toBe(
      true
    );
    expect(meetsCoverageThreshold({ ...RUN3_NER_CAPABILITY, measuredMicroRecall: 0.9799 })).toBe(
      false
    );
  });

  it('honours a caller-supplied target', () => {
    expect(meetsCoverageThreshold({ ...RUN3_NER_CAPABILITY, measuredMicroRecall: 0.5 }, 0.4)).toBe(
      true
    );
  });
});
