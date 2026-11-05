# ConfiPrompter

A compact desktop teleprompter for video calls, presentations and recordings, built with Electron.
It floats a small, click-through prompter right under your webcam. The prompter can be hidden from screen
sharing, and it can scroll on its own as you speak.

It opens two windows:

- **The teleprompter**: a frameless, transparent, always-on-top overlay. It is click-through, so the app
  behind it keeps working. Hover over it to reveal a small toolbar.
- **The control panel**: script editor, playback, appearance, voice and window settings.

## Highlights

### Compact & resizable overlay
- Starts as a slim 520 × 150 strip centred at the top of the screen, right below the camera.
- Drag any edge or corner to resize it, down to 180 × 64. Drag the grip on the toolbar to move it.
- Size presets (Compact / Medium / Large) and a **Snap under camera** button.
- The hover toolbar has play/pause, speed ±, text size ±, voice mode, move-lock, the control panel and hide.
  It disappears when the mouse leaves, and less-important buttons collapse on narrow widths.
- A thin progress bar, an adjustable **reading line**, current-paragraph highlighting and faded edges.

### Hidden from screen share
- **Stealth mode** (on by default) uses `setContentProtection`, so the prompter doesn't appear in screen
  shares, recordings or screenshots. You can hide the control panel too, so your script doesn't leak if
  you share your whole screen.
- The prompter never shows in the taskbar or dock. Use the tray icon or the shortcuts to reach it.
- **Platform support:**
  - **Windows 10 2004+:** full support (`WDA_EXCLUDEFROMCAPTURE`).
  - **macOS:** uses `NSWindowSharingNone`. Some newer ScreenCaptureKit-based capture may ignore it, so
    test with your call app first.
  - **Linux:** not possible. Compositors have no API for this, and the UI says so.

### Voice-reactive scrolling
- Turn on **Voice** and press Play. The script scrolls while you talk and holds when you stop, easing in
  and out smoothly.
- It runs fully offline. It is energy-based voice-activity detection (120 Hz–4 kHz band) with an adaptive
  noise floor that settles in after a few seconds of steady background noise.
- Adjustable sensitivity, a "keep scrolling after you stop" hold time, mic selection, a live level meter
  with a threshold marker, and a **Test microphone** button.
- **It doesn't block the mic for other apps:**
  - The mic is opened in normal shared mode, so Zoom, Meet, Teams and browser tabs can use it at the same
    time.
  - Echo cancellation, noise suppression and auto-gain are **off**. Chromium's auto-gain can change your
    system mic volume, and its echo canceller can put the device in "communications" mode, which ducks
    other audio on Windows. Raw capture avoids both.
  - **Release mic while paused** (on by default) closes the mic entirely whenever you aren't playing.
  - Audio never goes to the speakers and is never recorded or sent anywhere. Only its loudness is
    measured.

### Script features
- Load `.txt`, `.md` and `.docx` files with the button or by **dragging a file onto the control panel**.
- **Script library:** save, load and delete named scripts.
- Lightweight markup:

  | Write                  | Shows as                                                 |
  | ---------------------- | -------------------------------------------------------- |
  | `# Section`            | Small accent-coloured section heading                    |
  | `[pause]` (own line)   | Pause marker; auto-scroll stops there (can be turned off) |
  | `[smile]`, `[breathe]` | Dimmed, italic stage direction                           |
  | `**word**`             | Bold, underlined emphasis                                |

- Live word count and estimated read time. During playback it shows time remaining, or elapsed time in
  voice mode.
- Editing while paused keeps your place. Loading a new script starts from the top.

### Playback
- A 3-2-1 countdown before starting from the top (0–10 s, or off).
- A seekable progress bar, previous/next paragraph, back to top, and mouse-wheel / arrow-key nudging
  when the overlay is interactive.
- Smooth `requestAnimationFrame` scrolling with eased starts and stops.

### Appearance
- Text size, line spacing, typeface (Sans / Serif / Rounded / Mono) and alignment.
- Text colour presets plus a custom picker, and background colour plus opacity.
- Mirror mode for beam-splitter teleprompter rigs.
- The control panel follows your system's light/dark theme.

## Keyboard shortcuts

Global shortcuts work even while another app has focus. You can turn them off in **Window → Keyboard**.

| Shortcut                          | Action                     |
| --------------------------------- | -------------------------- |
| `Ctrl/Cmd+Shift+Space`            | Play / pause               |
| `Ctrl/Cmd+Shift+R`                | Back to top                |
| `Ctrl/Cmd+Shift+Up` / `Down`      | Speed ± 10                 |
| `Ctrl/Cmd+Shift+L`                | Show windows               |
| `Ctrl/Cmd+Shift+Q`                | Quit                       |
| `Ctrl/Cmd+Alt+Shift+V`            | Toggle voice mode          |
| `Ctrl/Cmd+Alt+Shift+M`            | Toggle move / resize mode  |
| `Ctrl/Cmd+Alt+Shift+H`            | Hide / show teleprompter   |
| `Ctrl/Cmd+Alt+Shift+S`            | Toggle stealth mode        |
| `Ctrl/Cmd+Alt+Shift+Left`/`Right` | Previous / next paragraph  |

The newer shortcuts use `Ctrl+Alt+Shift` so they don't take over common combos like `Ctrl+Shift+M`
(mute in Teams) or `Ctrl+Shift+V` (paste as plain text). If another app already owns a shortcut, the
Window tab lists it.

When the overlay itself has focus, these keys also work: `Space` play/pause, `↑`/`↓` nudge,
`←`/`→` previous/next paragraph, `Home` back to top, and `Esc` leaves move mode.

## Development

Requirements: Node.js 18+ and npm 9+.

```bash
npm install
```

```bash
npm start
```

Regenerate the app and tray icons (no dependencies):

```bash
npm run icons
```

## Build

```bash
npm run build
```

```bash
npm run build:win
```

```bash
npm run build:mac
```

```bash
npm run build:linux
```

Build output goes to `dist/`. The macOS build includes the `NSMicrophoneUsageDescription` that voice
mode needs.

## Notes

- **Linux:** Electron can't forward mouse-move events through a click-through window there, so the hover
  toolbar can't appear on its own. Use move / resize mode (`Ctrl+Alt+Shift+M`) or the tray menu instead.
- Closing a window hides it. The app keeps running in the tray. Use `Ctrl/Cmd+Shift+L` or the tray icon to
  bring it back, and `Ctrl/Cmd+Shift+Q` or the tray menu to quit.
- Settings and saved scripts are stored with `electron-store` in the app's user-data folder. On first
  launch, settings from the older **LensPrompt** build are imported automatically.

## Project layout

```
main.js                  Windows, stealth, tray, shortcuts, permissions, IPC
preload.js               Allow-listed IPC bridge (contextIsolation + sandbox)
utils/settings.js        Settings schema, validation, persistence, legacy migration
utils/library.js         Saved-script library
utils/fileLoader.js      .txt / .md / .docx loading
teleprompter/            Overlay: rendering, scrolling, hover toolbar, resize grips
teleprompter/voice.js    Offline voice-activity detector
control/                 Control panel UI
scripts/generate-icons.js  Dependency-free PNG icon generator
```
