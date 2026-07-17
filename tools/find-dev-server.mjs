// ===================================================================
//  Dev-server detector — used by the launchers (Start Pharmacographer.cmd
//  and start-pharmacographer.sh) to reuse a dev server that is already
//  serving this project instead of stacking a new one on the next free
//  port. Vite does not fail when its port is busy, it climbs to the next
//  one, so without this every launch quietly leaves another server behind.
//
//  Prints the URL of a running Pharmacographer dev server on stdout and
//  NOTHING else (no URL = none running). The launcher reads stdout straight
//  into a variable, so keep stdout to the URL alone; diagnostics go stderr.
//
//  Dependency-free ON PURPOSE: this runs before the node_modules check, on
//  a machine where nothing may be installed yet. Node builtins only — never
//  import from node_modules. It is also deliberately outside tsconfig's
//  `include`, eslint's `files`, and vitest's test glob.
// ===================================================================

import { pathToFileURL } from 'node:url';

// The window Vite climbs through: 5173 is its default and it walks upward
// to the next free port when one is taken. A server of ours that landed
// above PORT_END is simply not found — we start a fresh one. That fails
// safe (a missed reuse), which is the right way for this to be wrong.
const PORT_START = 5173;
const PORT_END = 5188;

// LOAD-BEARING: must stay identical to <title> in index.html. This is how
// the launcher tells OUR dev server from another project's — the port
// cannot, because several Vite projects climb past each other and 5173 is
// very often somebody else's app. Renaming the <title> without renaming
// this silently returns the launcher to stacking a server on every run.
// There is a matching comment beside the <title> tag in index.html.
const APP_TITLE = 'Pharmacographer';

const PROBE_TIMEOUT_MS = 1500;

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

/**
 * Fetch one port and return the page title it serves, or null when there is
 * nothing usable there (closed port, not HTTP, no title, too slow).
 */
async function probeTitle(port) {
  // Own the timer. Do NOT use AbortSignal.timeout() here: on Windows/libuv
  // the timers it arms outlive the answer, and exiting under them dies with
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
  // src\win\async.c` and exit code 127. clearTimeout in `finally` instead.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: controller.signal,
      headers: { accept: 'text/html' },
    });
    if (!res.ok) return null;
    const match = TITLE_RE.exec(await res.text());
    return match ? match[1].trim() : null;
  } catch {
    // Nothing listening, or it did not answer with HTML in time.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan the Vite port window for a dev server serving this project and return
 * its URL, or null if there is none. Identity is what a server SERVES, never
 * which port it happens to sit on — a port proves nothing.
 *
 * The honest limit: this recognises the APP, not the CHECKOUT. Two clones or
 * worktrees of Pharmacographer serve a byte-identical <title>, so with both
 * up this returns whichever sits on the lower port and the launcher may open
 * the other clone's code. Vite exposes no cwd over HTTP to tell them apart.
 * Single checkout — the normal case — is unaffected.
 */
export async function findRunningServer() {
  const ports = [];
  for (let port = PORT_START; port <= PORT_END; port++) ports.push(port);
  const titles = await Promise.all(ports.map(probeTitle));
  const port = ports.find((_, i) => titles[i] === APP_TITLE);
  return port === undefined ? null : `http://localhost:${port}/`;
}

// `import.meta.main` is node >=24.2 only. On anything older it is silently
// `undefined`, so the detector would print nothing, the launcher would read
// nothing, and it would go straight back to stacking with no sign it broke.
// Compare the entry point explicitly instead.
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  try {
    const url = await findRunningServer();
    if (url) process.stdout.write(`${url}\n`);
  } catch (err) {
    // A detector failure must never block the launcher: no stdout means
    // "none found", and the caller simply starts a fresh server.
    process.stderr.write(`dev-server detection failed: ${err?.message ?? err}\n`);
  }
  // Set exitCode rather than calling process.exit(), which can tear the
  // process down while libuv still holds handles (see the timer note above).
  process.exitCode = 0;
}
