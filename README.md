# LensPrompt

LensPrompt is a desktop teleprompter app built with Electron. It opens two windows:

- A floating teleprompter overlay (frameless, transparent, always on top)
- A control panel for script loading and playback/display settings

## Features

- Smooth auto-scroll using `requestAnimationFrame` + `transform: translateY`
- Global shortcuts:
  - `Ctrl/Cmd+Shift+Space`: play/pause
  - `Ctrl/Cmd+Shift+R`: reset to top
  - `Ctrl/Cmd+Shift+Up`: increase speed by 10
  - `Ctrl/Cmd+Shift+Down`: decrease speed by 10
  - `Ctrl/Cmd+Shift+L`: show windows when running in background
  - `Ctrl/Cmd+Shift+Q`: quit app
- Load `.txt`, `.md`, and `.docx` files
- Inline script editor
- Mirror mode and current-line highlight toggle
- Movable overlay mode toggle (lets you reposition the prompter easily)
- Overlay opacity, font size, speed, and text color controls
- Persisted settings (`electron-store`): speed, font size, opacity, text color, mirror mode, highlight mode, overlay bounds, and inline text

## Development

### Requirements

- Node.js 18+
- npm 9+

### Install

```bash
npm install
```

### Run

```bash
npm start
```

### Dev mode

```bash
npm run dev
```

## Build

Build for your platform:

```bash
npm run build
```

Platform-specific builds:

```bash
npm run build:win
npm run build:mac
npm run build:linux
```

Build output goes under `dist/`.

## Notes

- The teleprompter overlay ignores mouse events by default so clicks pass through to apps behind it.
- Enable "Movable overlay mode" (or hover the top drag strip) to move/resize the overlay.
- Closing windows hides the app to background instead of quitting; use `Ctrl/Cmd+Shift+L` to bring windows back.
- Add your own production app icons under `assets/` before publishing installers.
