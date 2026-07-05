# VideoControlsEnhancer

[![Obsidian](https://img.shields.io/badge/Obsidian-1.12.7+-purple.svg)](https://obsidian.md)
[![Release](https://img.shields.io/github/v/release/PostPollux/obsidian-video-controls-enhancer)](https://github.com/PostPollux/obsidian-video-controls-enhancer/releases)
[![Issues](https://img.shields.io/github/issues/PostPollux/obsidian-video-controls-enhancer)](https://github.com/PostPollux/obsidian-video-controls-enhancer/issues)
[![Last Commit](https://img.shields.io/github/last-commit/PostPollux/obsidian-video-controls-enhancer)](https://github.com/PostPollux/obsidian-video-controls-enhancer/commits/main)

---

> [!NOTE]
> This plugin enhances the native HTML5 `<video>` player used by Obsidian for **local video files**. It does **not** affect embedded third-party players (e.g. YouTube, Vimeo).

## Touch-first video controls for Obsidian

**VideoControlsEnhancer** supercharges Obsidian's built-in video player with gesture-driven playback controls inspired by modern mobile video apps. Scrub through a clip by dragging horizontally, adjust volume by dragging vertically, jump in configurable steps with a double tap, and fast-forward by holding down. Every action is accompanied by a lightweight on-screen overlay so you always see what's happening — no precision aiming at tiny progress bars required.

It works anywhere Obsidian renders a local video: notes, Canvas, embedded previews, and fullscreen mode on both desktop and mobile.


<video src="https://github.com/user-attachments/assets/8de959e8-6454-4fc1-a6af-4618f5b8fc2b" muted autoplay loop playsinline width="100%"></video>

[![Video Titel](https://img.youtube.com/vi/ni9dPoO59nE/maxresdefault.jpg)](https://www.youtube.com/watch?v=ni9dPoO59nE)

## Features

- **Horizontal scrubbing** — drag left/right to seek through the video, with an adjustable sensitivity slider so you can tune how far a full sweep travels.
- **Vertical volume control** — drag up/down anywhere on the video to change the volume; the overlay shows the current percentage and a speaker icon.
- **Double tap to jump** — a double tap on the right half jumps forward, on the left half jumps backward, by a configurable number of seconds (1–30).
- **Long press to fast-forward** — press and hold without dragging to play at an increased rate (1.5×–4×); release to return to normal speed. The trigger delay is configurable (200–1000 ms).
- **On-screen overlay** — each gesture shows a transient overlay (time, `+/-seconds`, `Nx` speed, or volume %) near the touch point.
- **Mobile fullscreen controls** — optionally shifts the native fullscreen progress bar/controls up a little so they don't sit in the system gesture zone, and blocks touch/mouse events from leaking through to the canvas behind a fullscreen video.
- **Works everywhere** — applies to every `<video>` element rendered by Obsidian, including dynamically inserted ones (via a `MutationObserver`), in notes, Canvas, and fullscreen.
- **Desktop and mobile** — tuned to behave well with touch gestures.
- **Fully configurable** — every feature can be toggled on or off independently in settings.

## Installation

### Community plugins (recommended)

1. Open Obsidian **Settings → Community plugins**.
2. Click **Browse** and search for **VideoControlsEnhancer**.
3. Click **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` (if present) from the latest [GitHub release](https://github.com/PostPollux/obsidian-video-controls-enhancer/releases).
2. Copy them into:
   ```
   <your-vault>/.obsidian/plugins/video-controls-enhancer/
   ```
3. Reload Obsidian.
4. Enable the plugin in **Settings → Community plugins**.

## Compatibility

- Requires Obsidian **1.12.7** or newer.
- Works on desktop and mobile.
- Affects only the native HTML5 video player for local files. Embedded players such as YouTube are not modified.

## Contributing

Issues and pull requests are welcome: [GitHub Issues](https://github.com/PostPollux/obsidian-video-controls-enhancer/issues)
