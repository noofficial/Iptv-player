# CableVision 2004

A personal IPTV web player styled like a mid-2000s digital cable box (Motorola DCT-2000 / Scientific-Atlanta era) — chunky plastic bezel, LED front-panel readout, TV Guide–blue channel grid, and a virtual remote.

Pure static site — no build step, no server-side rendering.

## Features

- **M3U playlist** loaded from a URL or pasted text; cached in `localStorage`
- Auto-tunes your last-watched channel on next visit
- **HLS** (`.m3u8`) via hls.js with native Safari fallback; plain `.mp4`/`.ts` work directly
- **Guide** overlay filtered by category and text (live TV only, like a real cable box)
- **Search** overlay across everything in your playlist — Live TV / Movies / Series
- Automatic classification of items into live / movie / series using Xtream Codes URL conventions (`/live/`, `/movie/`, `/series/`) and common `group-title` keywords
- Numpad direct-tune, channel up/down, last-channel, mute, volume
- Optional server proxy prefix for M3U URL fetches (bypasses browser CORS)
- Everything stored in `localStorage` only — no backend, nothing sent anywhere

## Keyboard / remote

| Key | Action |
|---|---|
| `G` | Guide (live channels) |
| `S` or `/` | Search (live + movies + series) |
| `I` | Info |
| `M` | Menu / settings |
| `↑ / ↓` | Channel up / down (or move selection in overlays) |
| `← / →` | Volume down / up (or switch tab in search) |
| `Tab` | Cycle search category tab |
| `Enter` | OK (open guide, or watch the selected item) |
| `B` | Last channel |
| `0–9` | Direct tune (waits ~1.5 s, or press ENTER) |
| `Space` | Pause / resume |
| `Esc` | Close overlays |

## Deploying to silverbasin.vegas on your VPS

Because the site is fully static, there is nothing to build or run — just serve the folder. Recommended: nginx on Debian/Ubuntu with a Let's Encrypt cert.

### 1. Copy the files

```sh
# on the VPS
sudo mkdir -p /var/www/silverbasin
sudo chown -R $USER:$USER /var/www/silverbasin

# from your laptop
rsync -avz --delete ./ user@silverbasin.vegas:/var/www/silverbasin/
```

Or clone the repo directly on the VPS:

```sh
sudo git clone https://github.com/noofficial/Iptv-player.git /var/www/silverbasin
```

### 2. nginx server block

Put this in `/etc/nginx/sites-available/silverbasin.vegas` and symlink it into `sites-enabled/`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name silverbasin.vegas www.silverbasin.vegas;

    root /var/www/silverbasin;
    index index.html;

    # -------- The static app ----------------------------------
    location / {
        try_files $uri $uri/ =404;
    }

    # -------- Optional CORS proxy for M3U fetches -------------
    # If a playlist host blocks browser fetches with a CORS error,
    # enter "/proxy?url=" in the app's MENU → SERVER PROXY field.
    # This forwards ONLY the encoded URL and strips CORS.
    location = /proxy {
        # Read the ?url= query arg into a variable
        set $target $arg_url;
        if ($target = "") { return 400 "missing url"; }

        # Only allow http/https targets
        if ($target !~* "^https?://") { return 400 "bad url"; }

        resolver 1.1.1.1 8.8.8.8 ipv6=off valid=300s;
        resolver_timeout 5s;

        proxy_pass $target;
        proxy_set_header Host $proxy_host;
        proxy_set_header User-Agent "CableVision2004/1.0";
        proxy_ssl_server_name on;
        proxy_buffering off;
        proxy_read_timeout 60s;

        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        add_header Access-Control-Allow-Headers "*" always;
    }
}
```

Enable and reload:

```sh
sudo ln -s /etc/nginx/sites-available/silverbasin.vegas /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 3. HTTPS with Let's Encrypt

```sh
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d silverbasin.vegas -d www.silverbasin.vegas
```

Certbot rewrites the server block to add `listen 443 ssl` and redirects HTTP → HTTPS. HTTPS is required in modern browsers for the `<video>` HLS pipeline to work reliably.

### 4. Point DNS

At your registrar, set an `A` record for `silverbasin.vegas` (and a `CNAME` for `www`) pointing to your VPS's public IP.

### 5. Use it

Open `https://silverbasin.vegas`, hit **MENU**, paste your M3U URL, press **LOAD URL**. If the fetch fails with a CORS error, set the **SERVER PROXY** field to `/proxy?url=` and load again — the request will now go through nginx on your own domain instead of the browser hitting the third-party host directly.

## Security note about the CORS proxy

The proxy in the nginx snippet is an *open* forward proxy — anyone who finds your `/proxy?url=` endpoint can use your VPS to fetch arbitrary URLs. If that matters for you, protect it with HTTP Basic auth (`auth_basic` + `htpasswd`), a shared secret in the query string, or restrict `allow`/`deny` by IP. For a personal site this is usually acceptable, but be aware of the tradeoff.

## Local development

Just open `index.html` in a browser, or run:

```sh
python3 -m http.server 8000
```

and browse to `http://localhost:8000`.
