# CableVision 2004

A personal IPTV web player styled like a mid-2000s digital cable box (think Motorola DCT-2000 / Scientific-Atlanta era) — chunky plastic bezel, LED front-panel readout, TV Guide–blue channel grid, and a virtual remote.

Pure static site — no build step, no server. Open `index.html` or host the folder anywhere (GitHub Pages, Netlify, a Raspberry Pi, `python3 -m http.server`).

## Use

1. Open the site. On first run the MENU opens automatically.
2. Paste your **M3U URL** and press **LOAD URL**, or click **PASTE M3U TEXT** and paste the file's contents. The playlist is saved in your browser's `localStorage` — next time you open the site it loads instantly and auto-tunes your last channel.
3. Press **GUIDE** to browse channels, arrow keys to move, **Enter** to watch.

### Remote / keyboard shortcuts

| Key | Action |
|---|---|
| `G` | Guide |
| `I` | Info |
| `M` | Menu / settings |
| `↑ / ↓` | Channel up / down (or move in the guide) |
| `← / →` | Volume down / up |
| `Enter` | OK (open guide, or watch selected) |
| `B` | Last channel |
| `0–9` | Direct tune (waits ~1.5 s, or press ENTER) |
| `Space` | Pause / resume |
| `Esc` | Close overlays |

## Notes

- HLS (`.m3u8`) is played via [hls.js](https://github.com/video-dev/hls.js) (loaded from a CDN); Safari uses native HLS. Plain `.mp4`/`.ts` are played directly by `<video>`.
- If fetching the M3U URL fails in your browser (CORS), use the **PASTE M3U TEXT** option instead — same result, just a manual copy/paste.
- Everything (URL, parsed channel list, last-watched channel, mute/autoplay options) is stored only in your browser's `localStorage`. There is no backend and nothing is sent anywhere.
