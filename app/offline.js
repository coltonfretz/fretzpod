// The library as stored on the phone (Android app, dedicated players phase
// 2): answers the same questions api.js asks Jellyfin, in the same shapes
// ({Items, TotalRecordCount}), from the details saved beside each stored
// song. Offline, Fretzpod browses what's on the phone: albums, artists and
// genres are whatever the stored songs belong to.
//
// Sorting follows Jellyfin's SortName closely enough for lists and the
// letter jump: case folded, a leading "the", "a" or "an" dropped.

const sortName = (s) => (s || '').toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
const byName = (a, b) => sortName(a.Name).localeCompare(sortName(b.Name));
const page = (list, start = 0, limit) => ({
  Items: limit === undefined || limit === null ? list.slice(start) : list.slice(start, start + limit),
  TotalRecordCount: list.length,
});
const shuffled = (list) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const trackOrder = (a, b) => (a.ParentIndexNumber || 0) - (b.ParentIndexNumber || 0)
  || (a.IndexNumber || 0) - (b.IndexNumber || 0) || byName(a, b);
const albumArtistOf = (s) => s.AlbumArtists?.[0] || (s.AlbumArtist ? { Name: s.AlbumArtist, Id: 'n:' + s.AlbumArtist } : null);
// Songs saved with Fields=Genres carry GenreItems; older saves only names.
const genresOf = (s) => s.GenreItems?.length ? s.GenreItems : (s.Genres || []).map((n) => ({ Name: n, Id: 'g:' + n }));

export class Local {
  // songs: stored songs' Jellyfin items; playlists: {id: {Name, ItemIds}};
  // favorites: Set of song ids.
  constructor(songs, playlists = {}, favorites = new Set()) {
    this.songs = songs.slice().sort(byName);
    this.byId = new Map(songs.map((s) => [s.Id, s]));
    this.favs = favorites;
    const albums = new Map(), artists = new Map(), genres = new Map();
    for (const s of songs) {
      const ar = albumArtistOf(s);
      if (s.AlbumId) {
        let al = albums.get(s.AlbumId);
        if (!al) {
          al = {
            Id: s.AlbumId, Name: s.Album || 'Album', Type: 'MusicAlbum', AlbumArtist: s.AlbumArtist || ar?.Name || '',
            AlbumArtists: ar ? [ar] : [], ProductionYear: s.ProductionYear, ChildCount: 0, songs: [], genres: new Set(),
          };
          albums.set(s.AlbumId, al);
        }
        al.ChildCount++;
        al.songs.push(s);
        for (const g of genresOf(s)) al.genres.add(g.Id);
      }
      if (ar && !artists.has(ar.Id)) artists.set(ar.Id, { Id: ar.Id, Name: ar.Name, Type: 'MusicArtist' });
      for (const g of genresOf(s)) if (!genres.has(g.Id)) genres.set(g.Id, { Id: g.Id, Name: g.Name, Type: 'MusicGenre' });
    }
    for (const al of albums.values()) al.songs.sort(trackOrder);
    this.albumMap = albums;
    this.albumList = [...albums.values()].sort(byName);
    this.artistList = [...artists.values()].sort(byName);
    this.genreList = [...genres.values()].sort(byName);
    this.playlistMap = playlists;
  }

  // Album items without the bookkeeping fields.
  static bare(al) {
    const { songs, genres, ...rest } = al;   // eslint-disable-line no-unused-vars
    return rest;
  }

  albums(start, limit) { return page(this.albumList.map(Local.bare), start, limit); }
  allAlbums() { return page(this.albumList.map(Local.bare)); }
  songsPage(start, limit) { return page(this.songs, start, limit); }
  albumSongs(id) { return page(this.albumMap.get(id)?.songs || []); }
  artistAlbumList(id) {
    return this.albumList.filter((al) => al.AlbumArtists[0]?.Id === id)
      .sort((a, b) => (a.ProductionYear || 0) - (b.ProductionYear || 0) || byName(a, b));
  }
  artistAlbums(id) { return page(this.artistAlbumList(id).map(Local.bare)); }
  artistSongs(id) { return page(this.artistAlbumList(id).flatMap((al) => al.songs)); }
  genreAlbums(id) {
    return page(this.albumList.filter((al) => al.genres.has(id))
      .sort((a, b) => sortName(a.AlbumArtist).localeCompare(sortName(b.AlbumArtist)) || byName(a, b)).map(Local.bare));
  }
  playlists() {
    const list = Object.entries(this.playlistMap)
      .map(([Id, p]) => ({ Id, Name: p.Name, Type: 'Playlist' }))
      .filter((p) => this.playlistSongList(p.Id).length)
      .sort(byName);
    return page(list);
  }
  playlistSongList(id) { return (this.playlistMap[id]?.ItemIds || []).map((x) => this.byId.get(x)).filter(Boolean); }
  playlistSongs(id) { return page(this.playlistSongList(id)); }
  randomSongs(n) { return page(shuffled(this.songs).slice(0, n)); }
  randomGenreSongs(id, n) { return page(shuffled(this.songs.filter((s) => genresOf(s).some((g) => g.Id === id))).slice(0, n)); }
  randomAlbums(n) { return page(shuffled(this.albumList).slice(0, n).map(Local.bare)); }
  albumArtists(start, limit) { return page(this.artistList, start, limit); }
  genres(start, limit) { return page(this.genreList, start, limit); }
  favoriteSongs() { return page(this.songs.filter((s) => this.favs.has(s.Id))); }

  // [{l, i}] like api.js letterIndex: where each letter starts.
  static letters(list) {
    const out = [];
    list.forEach((x, i) => {
      const c = sortName(x.Name).charAt(0).toUpperCase();
      const l = c >= 'A' && c <= 'Z' ? c : '#';
      if (!out.length || out[out.length - 1].l !== l) {
        if (!out.some((o) => o.l === l)) out.push({ l, i });
      }
    });
    return out;
  }
  artistLetters() { return Local.letters(this.artistList); }
  albumLetters() { return Local.letters(this.albumList); }

  search(term) {
    const t = term.toLowerCase();
    const has = (x) => (x.Name || '').toLowerCase().includes(t);
    return {
      artists: this.artistList.filter(has).slice(0, 5),
      albums: this.albumList.filter(has).slice(0, 10).map(Local.bare),
      songs: this.songs.filter(has).slice(0, 40),
    };
  }
}
