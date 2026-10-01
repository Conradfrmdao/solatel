// Where the files this page loads really are.
//
// Every file is published under a name carrying a hash of its contents
// (`assets/maps/yard.3fa2c19b0d4e6a71.glb`), so the server can tell a browser
// to keep it for good: a map is downloaded once rather than at the start of
// every match. The code asks for files by their plain names, and the page -
// the one file never cached - carries the table from those to the published
// ones, written by `client/build.mjs`. See `served.rs` on the server.

let names = null;

function table() {
  if (names) return names;
  const element = document.getElementById('solatel-manifest');
  names = element ? JSON.parse(element.textContent) : {};
  return names;
}

/**
 * The published URL of a file the code knows by its plain name, such as
 * `assets/maps/yard.glb`. A name the build did not publish is a mistake in
 * the build, and is said so here rather than as a 404 somewhere later.
 */
export function asset(path) {
  const published = table()[path];
  if (!published) throw new Error(`${path} is not in this build of the client`);
  return published;
}

/** Which build of the client this page is, as the server knows builds. */
export function clientBuild() {
  return document.querySelector('meta[name="solatel-build"]')?.content ?? 'solatel-client/unbuilt';
}
