// Site settings. build.py replaces this file with one made from
// site/site.json; this copy is the default (and what the dev server uses).
//   serverName  shown on the sign-in screen ("Sign in to ...")
//   purpleName  what Settings > Body calls the purple body
//   jellyfin    which Jellyfin to talk to: byHost maps the address the app
//               was opened at (host:port) to a Jellyfin URL, else default
export default {
  serverName: 'Jellyfin',
  purpleName: 'Purple',
  jellyfin: { default: '', byHost: {} },
};
