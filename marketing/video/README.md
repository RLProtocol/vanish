# Vanish promo video (57.5 s, 1920x1080)

Source for `vanish-promo.mp4`. The animation is a single HTML page whose `renderAt(t)` draws any moment
deterministically, so every frame is captured exactly.

- `promo.html` - scenes, timing, captions. Open `promo.html?play` in a browser for a live preview.
- `narration.json` - the voice-over lines (Microsoft neural voice "en-US-AndrewNeural" via `edge-tts`).
- `capture.mjs` - renders stills (`preview <t>...`) or all frames (`frames 30`) through a headless
  Chromium/Edge started with `--remote-debugging-port=9336`.

Re-render: generate the narration (`python -m edge_tts --voice en-US-AndrewNeural --rate +6% ...` per line),
render frames, mix narration + ambient pad, then encode with ffmpeg (H.264 CRF 18, AAC 192k @ 48 kHz).

## Feature videos (`series/`)

Three deep dives built on a shared engine (`base.css`, `engine.js`): `mixer.html`, `swap.html`, `buy.html`.
Scenes are keyed to narration lines, so timing follows the voice automatically.

    node build.mjs <mixer|swap|buy> tts            # narration + measured timeline (<name>.timing.js)
    node build.mjs <name> preview 3 12.5 ...        # stills for checking
    node build.mjs <name> render                    # all frames (30 fps)
    node build.mjs <name> mux                       # soundtrack + MP4 -> Desktop/Vanish videos/

Edit a line in `<name>.narration.json` (`text` = subtitle, optional `say` = what's spoken), then re-run all four steps.
