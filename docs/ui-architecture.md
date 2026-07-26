# UI Architecture and Theming

This document summarizes the UI architecture added for the Daft Citadel interface, covering the design system, navigation, real-time editors, and adaptive accessibility workflows.

## Design System (`src/ui/design-system/`)

- **Tokens** – `tokens.ts` defines neon-inspired colors, spacing, radii, opacity, and typography scales for both light and dark schemes. Use `mapIntentToColor` when you need semantic hues (primary/secondary/tertiary/success/etc.).
- **Typography helpers** – `typography.ts` exposes `createTextStyle` and enumerated variants (`caption`, `body`, `bodyLarge`, `title`, `headline`). Components should prefer these helpers instead of hard-coded font styles.
- **Theme provider** – Wrap screens with `ThemeProvider` to automatically resolve the platform color scheme (`useColorScheme`). Consumers can call `useTheme` for direct access to tokens.
- **Component primitives** – `components.tsx` introduces `NeonSurface`, `NeonText`, `NeonButton`, and `NeonToolbar`. Each primitive applies the neon palette, animated glow, and accessibility attributes (roles, state mapping). Use them as building blocks for future UI widgets.

### Theming Workflow

1. Import tokens: `import { useTheme } from 'src/ui/design-system';`
2. Pull values from `useTheme()` to build styles or pass `intent` props to primitives.
3. Add new tokens in `tokens.ts` and surface them through `ThemeTokens` to keep type safety.
4. Write Jest assertions in `src/ui/design-system/__tests__` whenever tokens change.

## Navigation (`src/ui/navigation/AppNavigator.tsx`)

- React Navigation powers a hybrid stack/tab structure.
  - The **Arrangement** tab hosts a native stack for editor-related routes (currently `ArrangementHome`).
  - **Mixer**, **Performance**, and **Settings** tabs render standalone screens.
- `AppNavigator` wraps the app with `ThemeProvider` and customizes the navigation theme using design-system tokens.
- `TabBarThemeProvider` adjusts tab bar height dynamically using `useAdaptiveLayout`, keeping ergonomics consistent across phones, tablets, and desktops.

### Adding Screens

1. Implement the screen component under `src/ui/screens/`.
2. Export it via `src/ui/screens/index.ts`.
3. Register it in the relevant navigator (stack or tab) inside `AppNavigator.tsx`.
4. Ensure screens use design-system primitives rather than raw React Native components for consistent theming.

## Real-time Editors (`src/ui/editors/`)

- **WaveformEditor** uses Skia (`@shopify/react-native-skia`) plus Reanimated worklets for playhead updates. Shared values (`useSharedValue`) keep the playhead reactive, and `useAnimatedReaction` pipes UI-thread progress back to JS callbacks without frame drops.
- **MidiPianoRoll** uses `Animated.ScrollView` with worklet-driven scroll handlers and derived values to build performance-friendly grid overlays.
- When integrating into new screens, pass normalized data (0–1 floats for waveforms, beat-aligned note start/duration).
- Provide fallbacks in your own features for devices without Skia acceleration by feature-detecting when necessary; both editors expose declarative props that can be conditionally rendered.

## Accessibility and Adaptive Layout (`src/ui/layout/useAdaptiveLayout.ts`)

- `useAdaptiveLayout` centralizes breakpoint detection (`phone`, `tablet`, `desktop`) and queries `AccessibilityInfo` for screen-reader and reduced-motion settings.
- Screens log diagnostics (see `SettingsScreen`) and adjust paddings/arrangements based on the returned `breakpoint`.
- When adding adaptive UI behaviors, read `prefersReducedMotion` before triggering complex animations, and offer alternative flows for `screenReaderEnabled` users.

## Platform Considerations

- React Navigation requires the usual native dependencies (`react-native-screens`, `react-native-safe-area-context`). Ensure they are linked when running on device/simulator.
- Skia and Reanimated demand extra build steps (e.g., Reanimated Babel plugin). Follow the respective installation guides when integrating with the mobile projects.
- For sideloading or tethered diagnostics (Xcode/AltStore workflows), confirm entitlements align with CoreMIDI/CoreWLAN usage described in the security research guidelines.

## Testing

- `npm run test` executes Jest suites located alongside the new modules.
- Mock files under `__mocks__/` stub Skia and Reanimated so tests execute in Node without native bindings.
- Extend `collectCoverageFrom` defaults automatically by creating tests under `__tests__/` directories.

## Future Enhancements

- Add dedicated navigation stacks for sub-flows (e.g., detailed mixer channels) by extending `AppTabParamList` and nested stack types.
- Introduce token-driven theming for audio-visual states (e.g., latency alerts) by expanding `ThemeIntent` enumerations and adjusting component primitives accordingly.
- Consider capturing real waveform/MIDI data from the audio engine packages once integration work begins; the editors are designed to receive streaming updates through shared values.
