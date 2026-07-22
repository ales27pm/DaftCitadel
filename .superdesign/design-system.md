# Daft Citadel Studio System

This design system replaces the shipped all-neon treatment with a restrained, high-contrast professional music-workstation interface. It preserves the recognizable mint, cyan, and magenta identity but uses color to communicate state and hierarchy instead of outlining every surface.

## Product principles

1. **Music first.** Tracks, scenes, transport, tempo, meters, and the next useful action outrank diagnostics.
2. **One transport truth.** Play, stop, rewind, tempo, time signature, and playhead form one persistent, coherent control cluster wherever transport is exposed.
3. **Useful from first launch.** An empty session must offer a clear primary action and honest supported alternatives; never show a dead-end sentence.
4. **Glanceable live use.** Performance information is readable at arm's length. Tempo and scene state never animate outside their intrinsic bounds.
5. **Calm surfaces, vivid state.** Static containers are neutral. Mint marks primary/playing/success, cyan marks timeline/playhead/information, magenta marks scenes/automation. Warnings and errors use dedicated colors.
6. **Phone landscape is still a phone.** Device class uses platform idiom or shortest-side logic; orientation changes composition, not identity.

## Approved adaptive direction

Both explored directions are approved as one product system rather than a user-facing mode toggle.

- **Studio Console** governs Arrangement and Mixer when a landscape or tablet workspace can support useful panes without clipping.
- **Performance Deck** governs the Performance route at every size and supplies the touch-first composition for compact portrait screens.
- Both directions share the same tokens, semantic tab bar, persisted session, transport controller, error handling, and accessibility behavior.
- Orientation or size changes only recompose the current route; they never create a second session or reset local transport state.

## Color tokens

Use only these colors and opacity variants derived from them.

| Token | Hex | Usage |
| --- | --- | --- |
| `canvas` | `#05070C` | App background |
| `surface-1` | `#0B1018` | Main panels and tab bar |
| `surface-2` | `#111926` | Elevated controls, selected rows, input wells |
| `surface-3` | `#182334` | Pressed/hovered neutral surface |
| `line` | `#273446` | Neutral dividers and default borders |
| `text-primary` | `#F4F7FB` | Titles, primary values, button text on dark surfaces |
| `text-secondary` | `#A9B5C5` | Supporting copy, labels, metadata |
| `text-tertiary` | `#748397` | Disabled and nonessential metadata; never essential instructions |
| `mint` | `#5CE6C3` | Primary action, playing state, success, active navigation |
| `mint-ink` | `#06231D` | Text/icons on mint fill |
| `cyan` | `#63C7F5` | Playhead, waveform, informational status |
| `magenta` | `#E171F5` | Scenes, automation, creative secondary state |
| `amber` | `#F2C66D` | Warning, bypassed plugin |
| `red` | `#FF7A88` | Error, crashed plugin, destructive state |

Rules:

- Default panel border is `line` at 70% opacity. Do not outline static panels in accent colors.
- Use at most one accent-filled primary action per action cluster.
- Accent glows are allowed only for active play state, focused playhead, or critical live feedback. Maximum shadow: 0 0 16px at 18% opacity.
- Disabled controls use `surface-2` plus `text-tertiary`; never fade the entire component below readable contrast.
- Large text and all essential controls must meet WCAG AA contrast. Pair every status color with an icon and text label.

## Typography

Use only the Apple system font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", sans-serif`.

| Role | Size / line height | Weight | Notes |
| --- | --- | --- | --- |
| Screen title | 28 / 34 | 700 | One per screen; 24 / 30 in compact landscape |
| Section title | 18 / 24 | 650 | Panel and group headers |
| Hero tempo | 44 / 48 | 700 | Tabular numerals; intrinsic-width container only |
| Metric value | 24 / 30 | 650 | Tabular numerals |
| Body | 16 / 22 | 400 | Default copy and button labels |
| Label | 14 / 18 | 600 | Controls, tabs, compact metadata |
| Caption | 12 / 16 | 500 | Secondary diagnostics only; never below 12 |

Use tabular numerals for BPM, playhead, dB, percentages, xrun counts, and timestamps. Never use letter spacing above 0.2px for body copy.

## Spacing and geometry

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40.
- Outer content gutter: 16 portrait phone, 20 compact landscape phone, 24 tablet, 32 desktop/web.
- Section gap: 20 compact, 24 regular.
- Control gap: 8; related metric gap: 12.
- Corner radii: 10 controls, 14 cards, 18 hero panels, 999 capsules.
- Minimum touch target: 44 x 44 points. Primary transport target: 52 x 44 minimum.
- Use one-pixel neutral borders. Never use double borders.
- Panels use no shadow by default. Elevated menus/overlays may use `0 12px 32px rgba(0,0,0,0.32)`.

## Icons

Use SF Symbols on iOS with matching Material Symbols on Android. In Superdesign, use equivalent Lucide icons with the same semantic meaning.

| Action/destination | Symbol |
| --- | --- |
| Arrangement | `waveform` |
| Mixer | `slider.horizontal.3` / faders |
| Performance | `square.grid.2x2.fill` / grid |
| Settings | `gearshape` |
| Play | `play.fill` |
| Stop | `stop.fill` |
| Rewind | `backward.end.fill` |
| Refresh | `arrow.clockwise` |
| Add track/new session | `plus` |
| Import/open | `folder` or `square.and.arrow.down` |
| Diagnostics | `waveform.path.ecg` |
| Audio status | `speaker.wave.2.fill` |
| Plugin error | `exclamationmark.triangle.fill` |

Every icon-only action needs an accessible label. Selected navigation uses the filled icon variant plus label color; selection never relies on color alone.

## Core components

### App shell

- Content fills the area above a safe-area-aware bottom tab bar.
- Tab bar uses `surface-1`, a single top divider, four equal destinations, semantic icons, and labels.
- Active tab uses mint icon and primary text plus a subtle `surface-2` selection shape. Inactive tabs use secondary text.
- In landscape phone, keep the bottom bar compact and preserve a minimum 44-point target; do not add fixed extra bottom padding beyond safe-area insets.

### Screen header

- Left: native screen title and optional compact context label.
- Right: only page-specific secondary actions. Refresh is an icon button or overflow action, never a fluorescent primary button.
- Global transport lives in its own cluster and is not duplicated as unrelated header buttons.

### Transport cluster

- Primary play/pause is mint-filled. Stop and rewind are neutral icon buttons.
- Show current position, BPM, and time signature adjacent to the controls when room allows.
- Disabled controls keep readable icon/text, remove glow, and expose disabled state semantically.
- Controls wrap or collapse into labeled icon buttons under narrow width; never clip.

### Studio panel

- `surface-1` background, neutral line border, radius 14 or 18, padding 16-20.
- Header row contains title, optional status, and optional contextual action.
- Do not nest full cards. Use dividers, rows, or subtle `surface-2` wells inside a panel.

### Empty session hub

- Lead with outcome: “Shape your first track.” The runtime already persists an empty `Untitled Session`, so do not imply that another session must be created first.
- One primary action: `Add first track`. This must be implemented through the existing session update API and a valid default routing graph before shipping.
- Do not show Load Demo, Import Audio, Record, Join/Invite, Browse Plugins, Cloud Sync, or Open Saved Session: those user-facing pipelines are not implemented in the current product.
- Add one short orientation sentence and a compact readiness row for audio engine status.
- Diagnostics belong behind a disclosure or Settings, not as the dominant empty-state card.

### Mixer channel

- Track name and mute/solo state at top.
- Tall level meter is the dominant mark; dB uses tabular numerals.
- Plugin inserts use compact neutral rows with explicit active/bypassed/crashed labels.
- Channel widths respond to available space; no fixed 45% basis with arbitrary margins.

### Performance deck

- Tempo and playing state are glanceable, bounded, and stable.
- Scene buttons form a predictable grid with 44-point targets and explicit active state.
- Motion is a brief state transition, never a continuous large pulse.
- Diagnostics can appear as one compact line only when enabled.

### Settings row

- Label and description remain left-aligned; native switch remains right-aligned.
- Group preferences under user-facing section labels. Put runtime diagnostics in a separate disclosure/troubleshooting section.
- Do not display internal breakpoint names as normal user content.

### Feedback

- Loading: compact progress state with task-specific copy.
- Empty: useful next action.
- Error: concise cause, recovery action, and contextual identifier where available.
- Plugin crash: nonblocking alert with Retry; recovered alerts dismiss automatically.
- Remove the current repeated Refresh actions. They call an in-memory ensure path and do not reread storage, so presenting them as recovery controls is misleading.

## Motion

- Durations: 160ms press/state, 220ms enter/layout, maximum 280ms.
- Scale only the pressed control or intrinsic metric, range 0.98-1.03.
- Never scale a full-width wrapper.
- Animate opacity and transform, not width/height.
- Respect reduced motion by removing decorative movement while retaining immediate state changes.
- No looping glow or pulse.

## Responsive compositions

### Portrait phone

- Single column, scrollable, title above transport cluster.
- Critical action and empty-state primary action remain above the fold.

### Landscape phone

- Treat as `phone + landscape`, not tablet.
- Use a compact top header and two-column content only where both panes remain at least 280 points wide.
- Arrangement: session hub or track list on the left, timeline/inspector on the right when populated.
- Performance: tempo/status rail on the left, scene grid on the right.
- Settings: one readable content column with max width 720, not edge-to-edge cards.

### Tablet

- Confirm tablet via device idiom or shortest side, not width alone.
- Use centered max width 1180 and intentional master/detail or two-column layouts.

### Web/desktop

- Max content width 1280 with flexible workspace panes.
- Keyboard focus must remain visible. Bottom navigation may remain for parity at this stage.

## Ground-truth viewport

The supplied runtime screenshots are 1280 x 588 image pixels from an iPhone17,1 in landscape. Draft and inspect the representative app shell at exactly 1280 x 588 while also ensuring responsive reflow below 736 and 390 widths.
