import { resolveBreakpoint } from '../useAdaptiveLayout';

describe('resolveBreakpoint', () => {
  it('categorizes phone widths correctly', () => {
    expect(resolveBreakpoint(375)).toBe('phone');
  });

  it('categorizes tablet widths correctly', () => {
    expect(resolveBreakpoint(900)).toBe('tablet');
  });

  it('categorizes desktop widths correctly', () => {
    expect(resolveBreakpoint(1600)).toBe('desktop');
  });
});
