// Jellyfin client: who we are (auth header), signing in and out, and the
// library calls the menus need. Everything goes from the browser straight to
// Jellyfin; see DESIGN.md "How it fits together" for why there's no proxy.
import { store, newId, log, clearLog } from './util.js';
import site from './config.js';

export const VERSION = '0.10.4';

// Which Jellyfin this copy talks to comes from the site settings
// (config.js, written by build.py from site/site.json): by the address the
// app was opened at, else the default. WHY per address: an https page can't
// call plain http (mixed content), so an https copy reached from outside
// needs Jellyfin's https address, while a home copy on plain http can use the
// LAN one. nginx's Content Security Policy allows each copy only the one it uses.
// On localhost (dev/devserver.py) Jellyfin is reached through the dev
// server's /jf pass-through instead.
const DEV = location.hostname === 'localhost';
export const JF = DEV ? location.origin + '/jf'
  : site.jellyfin.byHost[location.host] || site.jellyfin.default;
// Opened over https = probably away from home: Data saver by default.
export const AWAY = location.protocol === 'https:';
export const SERVER_NAME = site.serverName;

// Same storage keys as the phase 0 test page, so a sign-in there carries over.
function deviceId() {
  let id = store.get('fp.deviceId');
  if (!id) { id = newId(16); store.set('fp.deviceId', id); }
  return id;
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  return 'Browser';
}

let session = null;
try { session = JSON.parse(store.get('fp.session', 'null')); } catch { session = null; }
export const getSession = () => session;

// Jellyfin identifies the app by this header; the phone then shows up under
// Dashboard -> Devices as "Fretzpod", where the session can be revoked.
export function authHeader() {
  const parts = [
    'Client="Fretzpod"', `Device="${deviceName()}"`,
    `DeviceId="${deviceId()}"`, `Version="${VERSION}"`,
  ];
  if (session) parts.push(`Token="${session.token}"`);
  return 'MediaBrowser ' + parts.join(', ');
}

export async function request(path, opts = {}) {
  const headers = { Authorization: authHeader() };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(JF + path, { method: opts.method || 'GET', body: opts.body, headers, signal: opts.signal });
  if (res.status === 401 && session) {
    log('Jellyfin ended the session (revoked or expired)');
    clearSession();
    throw new Error('signed out');
  }
  // Only the path in errors: query strings can carry ids worth keeping out of logs.
  if (!res.ok) throw new Error(`${res.status} from ${path.split('?')[0]}`);
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : null;
}

const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) });

// Fretzpod's own helper services behind this page's nginx (speakers/,
// scores/): JSON in and out, with the phone's Jellyfin sign-in as the
// Authorization header so each service can ask Jellyfin who's calling.
// Errors carry .status (scores.js tells "name taken" from "offline").
export async function podCall(base, path, body) {
  const res = await fetch(`/${base}/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: authHeader(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = new Error(`${res.status} from ${base}/${path.split('?')[0]}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

// ---------- sign in / out ----------

function saveSession(result) {
  session = { token: result.AccessToken, userId: result.User.Id, name: result.User.Name };
  store.set('fp.session', JSON.stringify(session));
  log('signed in');
  window.dispatchEvent(new Event('fp-signin'));
}

function clearSession() {
  session = null;
  store.del('fp.session');
  window.dispatchEvent(new Event('fp-signout'));
}

// Returns the code to show and a promise that resolves once the person
// approves it in their Jellyfin app. cancel() stops the polling.
export async function quickConnect() {
  const init = await post('/QuickConnect/Initiate');
  let stopped = false;
  const done = new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = async () => {
      if (stopped) return;
      if (Date.now() - started > 5 * 60 * 1000) { reject(new Error('expired')); return; }
      try {
        const st = await request('/QuickConnect/Connect?secret=' + encodeURIComponent(init.Secret));
        if (st.Authenticated) {
          saveSession(await post('/Users/AuthenticateWithQuickConnect', { Secret: init.Secret }));
          resolve();
          return;
        }
      } catch (e) { log('quick connect: ' + e.message); }
      setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
  });
  return { code: init.Code, done, cancel: () => { stopped = true; } };
}

export async function passwordSignIn(user, pw) {
  saveSession(await post('/Users/AuthenticateByName', { Username: user, Pw: pw }));
}

export async function signOut() {
  try { await post('/Sessions/Logout'); } catch { /* signing out anyway */ }
  clearLog();
  clearSession();
}

// ---------- library ----------

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)).toString();

function items(params, opts) {
  return request('/Items?' + qs({
    userId: session.userId, Recursive: 'true', EnableTotalRecordCount: 'true',
    EnableUserData: 'false', ImageTypeLimit: '1', EnableImageTypes: 'Primary', ...params,
  }), opts);
}

export const albums = (start, limit) =>
  items({ IncludeItemTypes: 'MusicAlbum', SortBy: 'SortName', StartIndex: start, Limit: limit });
// Every album in one go, for Cover Flow (which sorts them itself; see there).
export const allAlbums = () => items({ IncludeItemTypes: 'MusicAlbum', EnableImages: 'false' });
export const songs = (start, limit) =>
  items({ IncludeItemTypes: 'Audio', SortBy: 'SortName', StartIndex: start, Limit: limit });
export const albumSongs = (albumId) =>
  items({ ParentId: albumId, IncludeItemTypes: 'Audio', SortBy: 'ParentIndexNumber,IndexNumber,SortName' });
export const artistAlbums = (artistId) =>
  items({ IncludeItemTypes: 'MusicAlbum', AlbumArtistIds: artistId, SortBy: 'ProductionYear,SortName' });
export const artistSongs = (artistId) =>
  items({ IncludeItemTypes: 'Audio', AlbumArtistIds: artistId, SortBy: 'ProductionYear,Album,ParentIndexNumber,IndexNumber', Limit: 2000 });
// An album lists under a genre when its songs carry it: Jellyfin gives each album
// the genres of its songs (plus whatever its online lookup adds, which genres()
// below keeps out of the list itself).
export const genreAlbums = (genreId) =>
  items({ IncludeItemTypes: 'MusicAlbum', GenreIds: genreId, SortBy: 'AlbumArtist,SortName', Limit: 1000 });
export const playlists = () => items({ IncludeItemTypes: 'Playlist', SortBy: 'SortName' });
export const playlistSongs = (id) => request(`/Playlists/${id}/Items?` + qs({ userId: session.userId, Limit: 3000 }));
export const randomSongs = (n) => items({ IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: n });
export const randomAlbumsWithArt = (n) =>
  items({ IncludeItemTypes: 'MusicAlbum', SortBy: 'Random', Limit: n, ImageTypes: 'Primary' });

export const albumArtists = (start, limit) => request('/Artists/AlbumArtists?' + qs({
  userId: session.userId, StartIndex: start, Limit: limit, SortBy: 'SortName',
  EnableTotalRecordCount: 'true', EnableImages: 'false', EnableUserData: 'false',
}));
// Only genres that songs carry. The song tags hold the library's ~20 broad genres
// (cleanup 2026-10-29); without IncludeItemTypes, Jellyfin also lists the hundreds
// of genres its online lookups attach to albums and artists ("acid house", "zolo").
export const genres = (start, limit) => request('/MusicGenres?' + qs({
  userId: session.userId, IncludeItemTypes: 'Audio', Recursive: 'true',
  StartIndex: start, Limit: limit, SortBy: 'SortName',
  EnableTotalRecordCount: 'true', EnableImages: 'false',
}));

// Who a song is by, for lists, Now Playing and the lock screen.
export const artistOf = (item) => item.AlbumArtist || item.Artists?.[0] || '';

// Album art needs no token.
export function artUrl(item, size) {
  const id = item.Type === 'MusicAlbum' ? item.Id : (item.AlbumId || item.Id);
  return `${JF}/Items/${id}/Images/Primary?fillWidth=${size}&fillHeight=${size}&quality=90`;
}

// A song from Jellyfin's universal endpoint. StartTimeTicks lets a seek past
// what's buffered restart the song partway in.
function streamUrl(item, ps, bitrate, startSec, params) {
  return `${JF}/Audio/${item.Id}/universal?` + qs({
    UserId: session.userId, DeviceId: deviceId(), PlaySessionId: ps,
    MaxStreamingBitrate: String(bitrate), TranscodingProtocol: 'http',
    StartTimeTicks: startSec > 0 ? String(Math.floor(startSec * 1e7)) : undefined,
    ...params,
  });
}

// One song as ADTS AAC (or MP3) for the continuous stream; fetched with the
// Authorization header, so no token in the URL.
export const songStreamUrl = (item, ps, { container, codec, bitrate, startSec = 0 }) =>
  streamUrl(item, ps, bitrate, startSec, { Container: container, TranscodingContainer: container, AudioCodec: codec });

// Basic mode (player.js): a plain <audio src>, which can't send headers, so
// the token rides in the URL as ApiKey= (Jellyfin 12.2 rejects api_key=), as
// Jellyfin's own web player does. Formats every browser plays directly;
// anything else Jellyfin turns into MP3.
export const basicStreamUrl = (item, ps, { bitrate, startSec = 0 }) =>
  streamUrl(item, ps, bitrate, startSec, {
    Container: 'mp3,aac,m4a|aac,m4b|aac,flac,wav', TranscodingContainer: 'mp3', AudioCodec: 'mp3', ApiKey: session.token,
  });

// ---------- letter positions (fast-spin jump) ----------

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// [{l, i}]: the index where each letter starts in a sorted list, from start
// positions per letter. Letters with nothing in them are dropped.
function letterIndex(starts, total) {
  const all = [{ l: '#', i: 0 }, ...LETTERS.map((l, k) => ({ l, i: starts[k] }))];
  return all.filter((x, k) => x.i < (k + 1 < all.length ? all[k + 1].i : total));
}

// Jellyfin's name filters give where each letter starts. Checked 2026-10-22
// against the sorted lists: right for album artists (NameLessThan) and albums
// (NameStartsWithOrGreater), wrong for songs, so Songs doesn't get the jump.
export async function artistLetters() {
  const count = (extra) => request('/Artists/AlbumArtists?' + qs({
    userId: session.userId, Limit: 0, EnableTotalRecordCount: 'true', ...extra,
  })).then((d) => d.TotalRecordCount);
  const [total, ...starts] = await Promise.all([count({}), ...LETTERS.map((L) => count({ NameLessThan: L }))]);
  return letterIndex(starts, total);
}

export async function albumLetters() {
  const count = (extra) => items({ IncludeItemTypes: 'MusicAlbum', Limit: 0, ...extra }).then((d) => d.TotalRecordCount);
  const [total, ...atOrAfter] = await Promise.all([count({}), ...LETTERS.map((L) => count({ NameStartsWithOrGreater: L }))]);
  return letterIndex(atOrAfter.map((n) => total - n), total);
}

// ---------- search ----------

// Artists, albums and songs matching what's been typed, as full items (songs
// need everything the player uses: album, artist, length).
export async function search(term, signal) {
  const opts = { signal };
  const [artists, albumsRes, songsRes] = await Promise.all([
    request('/Artists/AlbumArtists?' + qs({ userId: session.userId, searchTerm: term, Limit: 5, EnableImages: 'false' }), opts),
    items({ searchTerm: term, IncludeItemTypes: 'MusicAlbum', Limit: 10, EnableImages: 'false' }, opts),
    items({ searchTerm: term, IncludeItemTypes: 'Audio', Limit: 40, EnableImages: 'false' }, opts),
  ]);
  return { artists: artists.Items, albums: albumsRes.Items, songs: songsRes.Items };
}

// ---------- lyrics ----------

// [{text, start (seconds) or null, cues}], or null when the song has none.
export async function lyrics(itemId) {
  try {
    const d = await request(`/Audio/${itemId}/Lyrics`);
    const lines = d?.Lyrics || [];
    // Cues: word-by-word timing, when the lyrics have it (enhanced LRC);
    // each is a character range of the line and when it's sung.
    return lines.length ? lines.map((x) => ({
      text: x.Text || '',
      start: x.Start != null ? x.Start / 1e7 : null,
      cues: (x.Cues || []).filter((c) => c.Start != null && c.EndPosition > c.Position)
        .map((c) => ({ from: c.Position, to: c.EndPosition, start: c.Start / 1e7 })),
    })) : null;
  } catch (e) {
    if (!e.message.startsWith('404')) log(`lyrics: ${e.message}`);
    return null;
  }
}

// ---------- favorites ----------
//
// Jellyfin's own favorites (per user), so a song hearted here is hearted in
// every Jellyfin app too. Song lists load without user data (faster), so
// Now Playing asks about one song at a time.

export const isFavorite = (id) =>
  request(`/UserItems/${id}/UserData?` + qs({ userId: session.userId })).then((d) => !!d?.IsFavorite);
export const setFavorite = (id, on) =>
  request(`/UserFavoriteItems/${id}?` + qs({ userId: session.userId }), { method: on ? 'POST' : 'DELETE' })
    .then((d) => (d ? !!d.IsFavorite : on));
export const favoriteSongs = () =>
  items({ IncludeItemTypes: 'Audio', Filters: 'IsFavorite', SortBy: 'SortName', Limit: 3000 });
