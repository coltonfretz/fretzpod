// Jellyfin client: who we are (auth header), signing in and out, and the
// library calls the menus need. Everything goes from the browser straight to
// Jellyfin; see DESIGN.md "How it fits together" for why there's no proxy.
import { store, newId, log, clearLog } from './util.js';
import site from './config.js';
import { Local } from './offline.js';

export const VERSION = '0.32.1';

// Which Jellyfin this copy talks to. A site build (build.py with a
// site.json) knows its server: by the address the app was opened at, else
// the default. WHY per address: an https page can't call plain http (mixed
// content), so an https copy reached from outside needs Jellyfin's https
// address, while a home copy on plain http can use the LAN one. nginx's
// Content Security Policy allows each copy only the one it uses.
// On localhost (dev/devserver.py) Jellyfin is reached through the dev
// server's /jf pass-through instead.
//
// The app build (BYOS, "bring your own server": the Android app) knows no
// server. The person types theirs at sign-in (findServer below) and it's
// kept on the phone; JF is '' until then.
export const BYOS = !!site.byos;
const DEV = location.hostname === 'localhost';
const savedServer = () => { try { return JSON.parse(store.get('fp.server', 'null')); } catch { return null; } };
// let, not const: the sign-in screen sets it, and every module reading
// api.JF sees the change (ES module exports are live).
export let JF = BYOS ? (savedServer()?.url || '')
  : DEV ? location.origin + '/jf'
  : site.jellyfin.byHost[location.host] || site.jellyfin.default;
export let SERVER_NAME = BYOS ? (savedServer()?.name || 'Jellyfin') : site.serverName;
// Away from home: Data saver by default. The app build can't tell, so it
// assumes away (mobile data is the costly mistake).
export const AWAY = BYOS || location.protocol === 'https:';
// Fretzpod's own helpers (Speakers, High Scores) run beside a site's
// server, reached at the page's own /speakers/ and /scores/. The app build
// has no site of its own, but if it was built with one (config.js
// podHelpers, from site.json android.url) and is signed in to that site's
// Jellyfin, it uses that site's helpers at its full address (nginx lets the
// app's origin call /speakers/api/ and /scores/api/). Any other server:
// none. Recomputed when the server changes (useServer).
const sameServer = (a, b) => !!a && !!b && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
const helperBase = () => !BYOS ? '/'
  : site.podHelpers && sameServer(JF, site.podHelpers.server) ? site.podHelpers.url.replace(/\/*$/, '/')
  : null;
let HELPER_BASE = helperBase();
export let HELPERS = HELPER_BASE !== null;

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
  if (!HELPERS) { const e = new Error(`no ${base} here`); e.status = 404; throw e; }
  const res = await fetch(`${HELPER_BASE}${base}/api/${path}`, {
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

// ---------- which server (app build) ----------

// What the person typed, as the addresses worth trying, most likely first:
// "music.example.com" might be https, or plain http on Jellyfin's own port.
function candidates(typed) {
  let t = typed.trim().replace(/\/+$/, '');
  if (!t) return [];
  if (/^https?:\/\//i.test(t)) return [t];
  const hasPort = /:\d+(\/|$)/.test(t);
  const out = [`https://${t}`, `http://${t}`];
  if (!hasPort) out.push(`http://${t}:8096`, `https://${t}:8920`);
  return out;
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url + '/System/Info/Public', { signal: ctrl.signal });
    if (!res.ok) return null;
    const info = await res.json();
    // Anything can answer 200; Jellyfin's answer names its product and id.
    if (!info?.Id || (info.ProductName && !/jellyfin/i.test(info.ProductName))) return null;
    return { url, name: info.ServerName || 'Jellyfin', id: info.Id };
  } catch { return null; } finally { clearTimeout(timer); }
}

// Finds the Jellyfin at a typed address, or throws a message to show.
export async function findServer(typed) {
  const list = candidates(typed);
  if (!list.length) throw new Error('Type your server\'s address.');
  for (const url of list) {
    const found = await probe(url);
    if (found) return found;
  }
  throw new Error(`No Jellyfin answered at ${typed.trim()}. Check the address, and that the phone can reach it.`);
}

// Switches to a server found above. A sign-in belongs to one server, so
// switching signs out of the old one.
export function useServer(found) {
  if (session && JF !== found.url) clearSession();
  JF = found.url;
  SERVER_NAME = found.name;
  HELPER_BASE = helperBase();
  HELPERS = HELPER_BASE !== null;
  store.set('fp.server', JSON.stringify(found));
  log(`server set (${new URL(found.url).protocol.replace(':', '')})`);
  window.dispatchEvent(new Event('fp-server'));
}

export const hasServer = () => !!JF;

// Is Jellyfin there? For the "can't reach" screen at startup.
export async function reachable() {
  if (!JF) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try { return (await fetch(JF + '/System/Info/Public', { signal: ctrl.signal })).ok; }
  catch { return false; } finally { clearTimeout(timer); }
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

const on_albums = (start, limit) =>
  items({ IncludeItemTypes: 'MusicAlbum', SortBy: 'SortName', StartIndex: start, Limit: limit });
// Every album in one go, for Cover Flow (which sorts them itself; see there).
// ChildCount (songs per album) lets Cover Flow leave out one-song "albums".
const on_allAlbums = () => items({ IncludeItemTypes: 'MusicAlbum', EnableImages: 'false', Fields: 'ChildCount' });
const on_songs = (start, limit) =>
  items({ IncludeItemTypes: 'Audio', SortBy: 'SortName', StartIndex: start, Limit: limit });
const on_albumSongs = (albumId) =>
  items({ ParentId: albumId, IncludeItemTypes: 'Audio', SortBy: 'ParentIndexNumber,IndexNumber,SortName' });
const on_artistAlbums = (artistId) =>
  items({ IncludeItemTypes: 'MusicAlbum', AlbumArtistIds: artistId, SortBy: 'ProductionYear,SortName' });
const on_artistSongs = (artistId) =>
  items({ IncludeItemTypes: 'Audio', AlbumArtistIds: artistId, SortBy: 'ProductionYear,Album,ParentIndexNumber,IndexNumber', Limit: 2000 });
// An album lists under a genre when its songs carry it: Jellyfin gives each album
// the genres of its songs (plus whatever its online lookup adds, which genres()
// below keeps out of the list itself).
const on_genreAlbums = (genreId) =>
  items({ IncludeItemTypes: 'MusicAlbum', GenreIds: genreId, SortBy: 'AlbumArtist,SortName', Limit: 1000 });
const on_playlists = () => items({ IncludeItemTypes: 'Playlist', SortBy: 'SortName' });
const on_playlistSongs = (id) => request(`/Playlists/${id}/Items?` + qs({ userId: session.userId, Limit: 3000 }));
const on_randomSongs = (n) => items({ IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: n });
const on_randomGenreSongs = (genreId, n) =>
  items({ IncludeItemTypes: 'Audio', GenreIds: genreId, SortBy: 'Random', Limit: n });
const on_randomAlbumsWithArt = (n) =>
  items({ IncludeItemTypes: 'MusicAlbum', SortBy: 'Random', Limit: n, ImageTypes: 'Primary' });

const on_albumArtists = (start, limit) => request('/Artists/AlbumArtists?' + qs({
  userId: session.userId, StartIndex: start, Limit: limit, SortBy: 'SortName',
  EnableTotalRecordCount: 'true', EnableImages: 'false', EnableUserData: 'false',
}));
// Only genres that songs carry. The song tags hold the library's ~20 broad genres
// (cleanup 2026-10-29); without IncludeItemTypes, Jellyfin also lists the hundreds
// of genres its online lookups attach to albums and artists ("acid house", "zolo").
const on_genres = (start, limit) => request('/MusicGenres?' + qs({
  userId: session.userId, IncludeItemTypes: 'Audio', Recursive: 'true',
  StartIndex: start, Limit: limit, SortBy: 'SortName',
  EnableTotalRecordCount: 'true', EnableImages: 'false',
}));

// Offline (the app, with songs stored and Jellyfin out of reach), each of
// these answers from the phone's copy (offline.js) in the same shape.
const both = (online, offline) => (...a) => (OFFLINE ? Promise.resolve(offline(lib(), ...a)) : online(...a));
export const albums = both(on_albums, (L, s, n) => L.albums(s, n));
export const allAlbums = both(on_allAlbums, (L) => L.allAlbums());
export const songs = both(on_songs, (L, s, n) => L.songsPage(s, n));
export const albumSongs = both(on_albumSongs, (L, id) => L.albumSongs(id));
export const artistAlbums = both(on_artistAlbums, (L, id) => L.artistAlbums(id));
export const artistSongs = both(on_artistSongs, (L, id) => L.artistSongs(id));
export const genreAlbums = both(on_genreAlbums, (L, id) => L.genreAlbums(id));
export const playlists = both(on_playlists, (L) => L.playlists());
export const playlistSongs = both(on_playlistSongs, (L, id) => L.playlistSongs(id));
export const randomSongs = both(on_randomSongs, (L, n) => L.randomSongs(n));
export const randomGenreSongs = both(on_randomGenreSongs, (L, id, n) => L.randomGenreSongs(id, n));
export const randomAlbumsWithArt = both(on_randomAlbumsWithArt, (L, n) => L.randomAlbums(n));
export const albumArtists = both(on_albumArtists, (L, s, n) => L.albumArtists(s, n));
export const genres = both(on_genres, (L, s, n) => L.genres(s, n));
export const artistLetters = both(on_artistLetters, (L) => L.artistLetters());
export const albumLetters = both(on_albumLetters, (L) => L.albumLetters());
export const search = both(on_search, (L, term) => L.search(term));
// Favorites: the ids are kept on the phone whenever the list is fetched
// online, so the offline list matches.
export const favoriteSongs = both(
  () => on_favoriteSongs().then((d) => { metaPut('favorites', d.Items.map((x) => x.Id)); return d; }),
  (L) => L.favoriteSongs(),
);

// Who a song is by, for lists, Now Playing and the lock screen.
export const artistOf = (item) => item.AlbumArtist || item.Artists?.[0] || '';

// Album art needs no token. Offline it's the copy saved with the songs
// (one size, 600, scaled by the page).
export function artUrl(item, size) {
  const id = item.Type === 'MusicAlbum' ? item.Id : (item.AlbumId || item.Id);
  if (OFFLINE) return `/local/art/${id}`;
  return `${JF}/Items/${id}/Images/Primary?fillWidth=${size}&fillHeight=${size}&quality=90`;
}
const SAVED_ART = 600;

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
// Authorization header, so no token in the URL. A song stored on the phone
// (the app's offline library, below) comes from the phone instead, when
// the stream is raw ADTS AAC, the format it's stored in.
export const songStreamUrl = (item, ps, { container, codec, bitrate, startSec = 0, mux }) =>
  (!mux && codec === 'aac' && isStored(item.Id)) ? storedUrl(item.Id, startSec)
    : streamUrl(item, ps, bitrate, startSec, { Container: container, TranscodingContainer: container, AudioCodec: codec });

// ---------- songs stored on the phone (Android app) ----------
//
// The dedicated players keep the library on the phone (android/Library.java):
// each song as 256k ADTS AAC, served back to this page at /local/song/<id>.aac.
// Elsewhere there's no native side and nothing is stored.
const NATIVE = typeof window !== 'undefined' && window.FretzpodAndroid?.libraryIds ? window.FretzpodAndroid : null;
export const CAN_STORE = !!NATIVE;
export const STORE_BITRATE = 256000;
let stored = new Set();
try { if (NATIVE) stored = new Set(JSON.parse(NATIVE.libraryIds())); } catch { stored = new Set(); }
export const isStored = (id) => stored.has(id);
// The sync adds songs in the background, so the list is read again on
// coming back to the app and before going offline.
function reloadStored() {
  try { if (NATIVE) { stored = new Set(JSON.parse(NATIVE.libraryIds())); local = null; } } catch { /* keep the old list */ }
}
if (NATIVE) document.addEventListener('visibilitychange', () => { if (!document.hidden) reloadStored(); });
export const storedCount = () => { reloadStored(); return stored.size; };

// Offline: Jellyfin is out of reach and the phone has songs (main.js
// decides). Every library call above answers from `lib()` meanwhile.
export let OFFLINE = false;
let local = null;
const metaGet = (name) => { try { return NATIVE ? JSON.parse(NATIVE.libraryGet(name) || 'null') : null; } catch { return null; } };
const metaPut = (name, v) => { try { NATIVE?.libraryPut(name, JSON.stringify(v)); } catch { /* not kept */ } };
function lib() {
  if (!local) local = new Local(storedSongs(), metaGet('playlists') || {}, new Set(metaGet('favorites') || []));
  return local;
}
export function setOffline(on) {
  if (on === OFFLINE) return;
  OFFLINE = on;
  local = null;
  log(on ? 'offline: playing from the phone' : 'back online');
  if (!on) sendFavQueue();
  window.dispatchEvent(new Event('fp-offline'));
}
const storedUrl = (id, startSec) => `/local/song/${id}.aac` + (startSec > 0 ? `?start=${startSec.toFixed(3)}` : '');

// The phone syncs the whole library by itself (android Sync.java), as the
// person signed in here: it gets the server, user and Authorization header
// whenever they change, and "" on sign-out (the songs stay).
function tellSync() {
  try { NATIVE?.librarySetAccount?.(session && JF ? JSON.stringify({ server: JF, userId: session.userId, auth: authHeader() }) : ''); }
  catch (e) { log(`sync account: ${e.message}`); }
}
if (NATIVE) {
  tellSync();
  for (const ev of ['fp-signin', 'fp-signout', 'fp-server']) window.addEventListener(ev, tellSync);
}
// Settings > Phone Library > Sync Now. False if it couldn't be started.
export const syncNow = () => { try { return !!NATIVE?.librarySyncNow?.(); } catch { return false; } };

// {songs, bytes, free, busy, sync}, or null off the app.
export function storedInfo() {
  try { return NATIVE ? JSON.parse(NATIVE.libraryInfo()) : null; } catch { return null; }
}

// Saves songs to the phone, one at a time in the background. onEach gets
// {id, ok, done, total, error} after every song.
let onSaved = null;
if (NATIVE) {
  window.fretzpodLibrary = (json) => {
    let r; try { r = JSON.parse(json); } catch { return; }
    if (r.ok && r.id) { stored.add(r.id); local = null; }
    if (!r.ok) log(`saving song ${r.done}/${r.total} failed: ${r.error}`);
    onSaved?.(r);
  };
}
// Resolves to how many weren't stored yet. Songs already stored go along
// too, so their details, art and lyrics get saved beside them. The items
// are fetched again with their genres (lists load without them).
// playlist: {Id, Name} when saving a playlist, so it lists offline too.
export async function saveSongs(items, onEach, playlist = null) {
  if (!NATIVE || !session || OFFLINE) return 0;
  const ids = items.filter((x) => x.Type === 'Audio').map((x) => x.Id);
  if (!ids.length) return 0;
  const full = [];
  for (let i = 0; i < ids.length; i += 100) {
    const d = await request('/Items?' + qs({ userId: session.userId, Ids: ids.slice(i, i + 100).join(','), Fields: 'Genres', EnableUserData: 'false' }));
    full.push(...d.Items);
  }
  if (playlist) {
    const pl = metaGet('playlists') || {};
    pl[playlist.Id] = { Name: playlist.Name, ItemIds: ids };
    metaPut('playlists', pl);
  }
  local = null;
  onSaved = onEach;
  NATIVE.librarySave(JSON.stringify(full.map((x) => ({
    id: x.Id,
    item: x,
    secs: (x.RunTimeTicks || 0) / 1e7,
    url: streamUrl(x, newId(), STORE_BITRATE, 0, { Container: 'aac', TranscodingContainer: 'aac', AudioCodec: 'aac' }),
    art: x.AlbumId ? { id: x.AlbumId, url: `${JF}/Items/${x.AlbumId}/Images/Primary?fillWidth=${SAVED_ART}&fillHeight=${SAVED_ART}&quality=90` } : undefined,
    lyrics: x.HasLyrics ? `${JF}/Audio/${x.Id}/Lyrics` : undefined,
  }))), authHeader());
  return full.filter((x) => !stored.has(x.Id)).length;
}

async function localJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} from ${path.split('/').slice(0, 3).join('/')}`);
  return res.json();
}

// Stored songs with their details, sorted like an iPod: artist, album,
// disc, track. For playing with Jellyfin out of reach.
// Stored songs' items in the order of ids (Android Auto's picks, main.js),
// from the offline library's lookup (lib(), kept until the stored list
// changes) rather than reading every item again for each pick.
export function storedItems(ids) {
  const byId = lib().byId;
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export function storedSongs() {
  let list = [];
  try { list = NATIVE ? JSON.parse(NATIVE.libraryItems()) : []; } catch { list = []; }
  const key = (s) => [artistOf(s).toLowerCase(), (s.Album || '').toLowerCase()];
  return list.filter((s) => stored.has(s.Id)).sort((a, b) => {
    const [ra, la] = key(a), [rb, lb] = key(b);
    return ra.localeCompare(rb) || la.localeCompare(lb)
      || (a.ParentIndexNumber || 0) - (b.ParentIndexNumber || 0) || (a.IndexNumber || 0) - (b.IndexNumber || 0);
  });
}

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
async function on_artistLetters() {
  const count = (extra) => request('/Artists/AlbumArtists?' + qs({
    userId: session.userId, Limit: 0, EnableTotalRecordCount: 'true', ...extra,
  })).then((d) => d.TotalRecordCount);
  const [total, ...starts] = await Promise.all([count({}), ...LETTERS.map((L) => count({ NameLessThan: L }))]);
  return letterIndex(starts, total);
}

async function on_albumLetters() {
  const count = (extra) => items({ IncludeItemTypes: 'MusicAlbum', Limit: 0, ...extra }).then((d) => d.TotalRecordCount);
  const [total, ...atOrAfter] = await Promise.all([count({}), ...LETTERS.map((L) => count({ NameStartsWithOrGreater: L }))]);
  return letterIndex(atOrAfter.map((n) => total - n), total);
}

// ---------- search ----------

// Artists, albums and songs matching what's been typed, as full items (songs
// need everything the player uses: album, artist, length).
async function on_search(term, signal) {
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
    const d = OFFLINE ? await localJson(`/local/lyrics/${itemId}.json`) : await request(`/Audio/${itemId}/Lyrics`);
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

// Offline, hearts change the phone's copy and wait in a queue (fp.favQueue,
// id -> on) that's sent once Jellyfin answers again (setOffline).
export const isFavorite = (id) => (OFFLINE ? Promise.resolve(lib().favs.has(id))
  : request(`/UserItems/${id}/UserData?` + qs({ userId: session.userId })).then((d) => !!d?.IsFavorite));
const sendFavorite = (id, on) =>
  request(`/UserFavoriteItems/${id}?` + qs({ userId: session.userId }), { method: on ? 'POST' : 'DELETE' })
    .then((d) => (d ? !!d.IsFavorite : on));
export function setFavorite(id, on) {
  if (OFFLINE) {
    const q = favQueue();
    q[id] = on;
    store.set('fp.favQueue', JSON.stringify(q));
    keepFavorite(id, on);
    return Promise.resolve(on);
  }
  return sendFavorite(id, on).then((v) => { keepFavorite(id, v); return v; });
}
const favQueue = () => { try { return JSON.parse(store.get('fp.favQueue', '{}')) || {}; } catch { return {}; } };
function keepFavorite(id, on) {
  if (!NATIVE) return;
  const ids = new Set(metaGet('favorites') || []);
  if (on) ids.add(id); else ids.delete(id);
  metaPut('favorites', [...ids]);
  if (local) { if (on) local.favs.add(id); else local.favs.delete(id); }
}
async function sendFavQueue() {
  const q = favQueue();
  for (const [id, on] of Object.entries(q)) {
    try { await sendFavorite(id, on); delete q[id]; } catch (e) { log(`queued favorite: ${e.message}`); break; }
  }
  store.set('fp.favQueue', JSON.stringify(q));
}
// ---------- the hold menu (ui.js) ----------

// Instant Mix: Jellyfin's own "songs like this one", from a song, an album or
// an artist (its genres, the artist, similar artists).
export const instantMix = (id) => OFFLINE ? Promise.reject(new Error('offline')) : request(`/Items/${id}/InstantMix?` + qs({
  userId: session.userId, Limit: 100, EnableUserData: 'false', ImageTypeLimit: '1', EnableImageTypes: 'Primary',
}));
// Fails with 403 on a playlist this account can only look at (someone
// else's, shared without editing).
export const addToPlaylist = (playlistId, ids) => OFFLINE ? Promise.reject(new Error('offline')) :
  request(`/Playlists/${playlistId}/Items?` + qs({ userId: session.userId, ids: ids.join(',') }), { method: 'POST' });

const on_favoriteSongs = () =>
  items({ IncludeItemTypes: 'Audio', Filters: 'IsFavorite', SortBy: 'SortName', Limit: 3000 });
