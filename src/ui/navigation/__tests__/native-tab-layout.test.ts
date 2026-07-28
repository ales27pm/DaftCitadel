import { resolveNativeTabBarMetrics } from '../native-tab-layout';

describe('resolveNativeTabBarMetrics', () => {
  it('adds the device bottom inset beneath phone tab labels', () => {
    expect(resolveNativeTabBarMetrics('phone', 34)).toEqual({
      height: 106,
      paddingBottom: 42,
      paddingTop: 8,
    });
  });

  it('preserves tablet visual height while adding its bottom inset', () => {
    expect(resolveNativeTabBarMetrics('tablet', 20)).toEqual({
      height: 96,
      paddingBottom: 28,
      paddingTop: 8,
    });
  });

  it('sanitizes invalid and negative insets', () => {
    expect(resolveNativeTabBarMetrics('phone', Number.NaN)).toEqual({
      height: 72,
      paddingBottom: 8,
      paddingTop: 8,
    });
    expect(resolveNativeTabBarMetrics('phone', -12)).toEqual({
      height: 72,
      paddingBottom: 8,
      paddingTop: 8,
    });
  });
});
