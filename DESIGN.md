# Fretzpod design notes

Why Fretzpod works the way it does. The code comments point here by section name.

## How it fits together

```
phone ──► Fretzpod (nginx: static files, plus /speakers/ and /scores/api/ to the optional helpers)
  │
  └──────► Jellyfin (every music, art and library request, straight from the browser)
```

**The browser talks to Jellyfin directly, not through Fretzpod.** Jellyfin answers cross-site requests (`Access-Control-Allow-Origin: *`), so no proxy is needed. That keeps two things true:

- Music requests take the same path as any other Jellyfin client. If your Jellyfin tells home from away by the client's address (for remote bitrate limits), that keeps working. A relay in the middle would make everyone look like they're at home.
- Fretzpod itself is static files: no Jellyfin key, no secrets, nothing worth breaking into.

**Fretzpod gets its own address, not a path under Jellyfin's.** Pages on the same address share browser storage, and Jellyfin's web player keeps its login there. On separate addresses, a bug in one can't read the other's login.

**Which Jellyfin a copy uses** comes from `site.json` (`jellyfin.byHost`, else `jellyfin.default`). An https page isn't allowed to call plain http, so a copy opened over https from outside needs Jellyfin's https address, while a home copy on plain http can use the LAN one. nginx's Content Security Policy allows each copy only the Jellyfin it uses.

## Sign-in

- **Quick Connect** (the default): the app shows a code, you approve it in another Jellyfin app or the web UI. No password typed on a phone.
- **Username and password**: `POST /Users/AuthenticateByName`.
- The session token stays in the app's own browser storage. The phone shows up in Jellyfin under Dashboard > Devices as "Fretzpod"; delete it there and the session ends. Sign Out logs the session out and wipes storage.
- Songs are fetched with `fetch()` and the `Authorization` header, so the token never sits in a URL. The one exception is basic mode (below), where a plain `<audio src>` can't send headers; that URL carries `ApiKey=` like Jellyfin's own web player does, and is never logged.

## Playback

**One continuous stream.** One `<audio>` element plays one endless Media Source stream, and the app appends the next song before the current one runs out. To the browser it's a single long track.

Why: tested on an Android phone with the screen off, every approach that started a new song (a second player, swapping the source, either on the `ended` event or on a timer) stopped at the first song change. Once the screen is off, Android Chrome freezes a page that stops making sound, even for a moment, and won't start audio again until the screen is on. Only the continuous stream kept playing: three song changes in eleven minutes, locked, each within a second.

- One stream means one format, so Jellyfin transcodes every song to AAC (320k, or 128k on Data saver). Gapless playback comes free.
- About 90 s is kept buffered ahead of the playhead and anything older than 60 s behind is trimmed, so memory stays small however long it plays.
- Skip, previous and seeking far back restart the stream at the new spot (allowed, since they're user actions).
- Lock screen and notification controls through the Media Session API.
- **Basic mode** is the last resort for browsers with no usable Media Source: a plain `<audio>` per song. It works anywhere, but on Android the music may stop between songs with the screen off.
- Lyrics from Jellyfin when it has them (word timing, line timing, or plain). Nothing fetched from outside.

## Other browsers and computers

Measured in real engines with Playwright:

| Engine | audio/aac | audio/mpeg | audio/mp4 (AAC) |
|---|---|---|---|
| Chrome | plays | n/a | plays |
| Firefox | refuses | refuses | plays |
| WebKit | says yes, then fails | says yes | plays |

So `app/mp4mux.js` rewraps Jellyfin's ADTS AAC into fragmented MP4 in the page: frames copied byte for byte, no re-encoding (checked sample-identical against the original). Format order: AAC, then MP4, then MP3; a format that claims support but errors hands over to the next, then basic mode. Settings > About shows which one a device got.

- **iPhone:** iOS doesn't let a page set the volume, so on Now Playing the wheel scrubs instead and the phone's buttons do volume. Safari has no web vibration, so iPhones get the click sound only and the Haptics setting is hidden.
- **Computers:** arrow keys turn the wheel, left/right are previous/next, Enter is the center button, Space is play/pause, Esc or Backspace is MENU. The mouse or trackpad scroll wheel turns it too.
- `tools/engines` holds the Playwright checks (`sweep.mjs` walks the whole app in Firefox and WebKit dressed as an iPhone).

## Privacy

Gather nothing about listeners that the app doesn't strictly need.

- **No play reporting** to Jellyfin (`/Sessions/Playing*`): listening on Fretzpod never lands in Jellyfin's activity log, play counts or "now playing". Jellyfin still sees the sign-in, the device, and the requests for the songs and art it serves.
- nginx keeps no access log, so no visitor addresses or requests are recorded.
- The app's own log (Settings > About > Log) holds no song names, and Sign Out wipes it.
- No analytics, no CDNs, no outside requests (the Content Security Policy enforces it).

## Security

- Content Security Policy: scripts and styles only from Fretzpod itself, no inline code; network, images and media only to that copy's Jellyfin (plus the TV servers in `app/tv-hosts.json`); no frames.
- Everything from Jellyfin (titles, names) goes into the page as text, never as HTML.
- The example deployments run as non-root with a read-only root filesystem, all capabilities dropped and no service account token.
- Making Fretzpod public adds a static site, not a new way into Jellyfin: sign-in is Jellyfin's own, with its normal failed-login lockout.

## TV

The free channels from the Tuner Jellyfin plugin, on the iPod screen. The TV menu only appears when the plugin is installed.

- Lineup, guide and a playback ticket from the plugin (`/Tuner/tv`, `/Tuner/tv/guide`) with the person's own sign-in. Antenna channels are left out.
- Channels play straight from their own servers with hls.js, and only servers listed in `app/tv-hosts.json` (also the Content Security Policy). The few servers that refuse a web page go through the plugin's relay. A channel on an unlisted server is hidden rather than relayed, so viewers' streams don't ride on the server's connection.
- Turning the wheel surfs (tunes once the wheel settles, so a fast spin skips channels). Turning the phone sideways goes full screen.

## Speakers

Optional, for Sonos speakers controlled by Home Assistant. Pick a speaker and the music moves there; the wheel then drives the speaker. Pick "This phone" and it comes back at the same song and spot. One or more speakers can play together as a Sonos group.

```
phone --/speakers/api--> fretzpod-speakers --HA REST--> Home Assistant --> Sonos
Sonos --PUBLIC_BASE/speakers/audio/<signed link>--> nginx --> fretzpod-speakers --> Jellyfin
```

- `fretzpod-speakers` (stdlib Python) holds the Home Assistant token and its own Jellyfin key, so neither reaches a phone or a speaker.
- **Only allowed accounts.** It checks the phone's own Jellyfin sign-in (`/Users/Me`) against `ALLOWED_USERS`. Anyone else gets "not allowed" and never sees a Speakers menu.
- **Signed song links, not keys.** A Sonos downloads songs itself, and Home Assistant's history stores every address a speaker played. So the speakers only ever get links like `/speakers/audio/<song>.<mode>.<expiry>.<signature>.flac`: one song, 12 hours, useless for anything else.
- Original files where Sonos can play them (MP3, AAC, FLAC up to 48 kHz), with byte ranges so the speaker can seek. Anything else is converted to 320k MP3.
- Speaker state is read from the speaker itself over UPnP, because Home Assistant's copy can run about 30 s stale when the speakers can't push events back to it. Commands still go through Home Assistant.
- On my setup the speakers sit on a separate network that must never reach into the server's, so `PUBLIC_BASE` is Fretzpod's public https address and songs come in from outside like any visitor.

## High scores

Optional. One shared board per game (Vortex, Space Sheep) for everyone on the server.

- `fretzpod-scores` (stdlib Python) holds no secrets. It asks Jellyfin `/Users/Me` with the phone's own sign-in to know who's posting.
- It keeps, per Jellyfin user id, a number and a name the person picked, and per game their best score and the day they set it. One JSON file, no request log. Jellyfin names are never stored or shown: you're "Player 3" until you pick a name with the wheel (A-Z, 0-9, space, dash, up to 10, unique).
- Scores that can't be sent wait on the phone and go with the next submit.
- Anyone signed in could post a made-up score with curl. It's a board among friends; to drop one, delete it from `/data/scores.json`.

## Tiki Golf

An original minigolf game inspired by the tiki minigolf in the PS2 game *Madagascar* (2005). Original holes and art; nothing copied. Two courses of nine holes. Turn the wheel to aim, press the center to lock it, then again to stop the power meter. Gadgets include gates, pool bumpers, tubes, moles, cranes, slopes and moving obstacles. Every hole is checked in `tools/sims` to be finishable at or under par. Coins from good holes buy balls and trails in the Shop.
