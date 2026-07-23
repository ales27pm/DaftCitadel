import { resolveAdaptiveLayout, resolveBreakpoint } from '../useAdaptiveLayout';

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

describe('resolveAdaptiveLayout', () => {
  it('keeps a wide landscape phone in the phone breakpoint', () => {
    expect(resolveAdaptiveLayout(1280, 588, { platform: 'ios' })).toEqual({
      width: 1280,
      height: 588,
      breakpoint: 'phone',
      orientation: 'landscape',
      isTablet: false,
      isLandscape: true,
      workspaceMode: 'studio',
      contentPadding: 20,
      maxContentWidth: 1280,
    });
  });

  it('uses the device idiom instead of promoting a wide phone to tablet', () => {
    const layout = resolveAdaptiveLayout(1366, 1024, {
      platform: 'ios',
      deviceIdiom: 'phone',
    });

    expect(layout.breakpoint).toBe('phone');
    expect(layout.isTablet).toBe(false);
    expect(layout.workspaceMode).toBe('studio');
  });

  it('uses deck composition and compact spacing on a portrait phone', () => {
    const layout = resolveAdaptiveLayout(390, 844, {
      platform: 'ios',
      deviceIdiom: 'phone',
    });

    expect(layout).toMatchObject({
      breakpoint: 'phone',
      orientation: 'portrait',
      isLandscape: false,
      isTablet: false,
      workspaceMode: 'deck',
      contentPadding: 16,
      maxContentWidth: 390,
    });
  });

  it('honors a tablet idiom in portrait and applies tablet geometry', () => {
    const layout = resolveAdaptiveLayout(834, 1194, {
      platform: 'ios',
      deviceIdiom: 'tablet',
    });

    expect(layout).toMatchObject({
      breakpoint: 'tablet',
      orientation: 'portrait',
      isLandscape: false,
      isTablet: true,
      workspaceMode: 'studio',
      contentPadding: 24,
      maxContentWidth: 1180,
    });
  });

  it('uses the desktop cap for a wide web workspace', () => {
    const layout = resolveAdaptiveLayout(1600, 900, { platform: 'web' });

    expect(layout).toMatchObject({
      breakpoint: 'desktop',
      workspaceMode: 'studio',
      contentPadding: 32,
      maxContentWidth: 1280,
    });
  });
});
