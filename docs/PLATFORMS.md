# Platforms, and why there is a native build

## The thing that was actually in the way

The first version of this was a static page, and a static page cannot touch
your filesystem. That looked like a property of "browser-based", and it isn't.

JupyterLab runs in a browser and reads and writes your files freely, because
Jupyter is *two* programs: a Python process running as you, doing all the I/O,
and a browser tab that is only a user interface talking to `localhost`. The tab
never touches the disk. The sandbox was never about the browser — it was about
there being no local process.

So the real question was never "browser or not". It was **"is something running
on this machine with your permissions?"** Once the answer is yes, real file
access comes back and the UI can still be HTML.

## What that meant for the options

| | Real paths | Open in native app | Mobile | Cost |
| --- | --- | --- | --- | --- |
| Static page + File System Access API | inside one granted folder | no | no | none |
| Local helper process (the Jupyter model) | yes | yes | no | a process to launch |
| Electron | yes | yes | no | ~96MB per app |
| **Tauri v2** | yes | yes | iOS + Android targets | a Rust toolchain to *build* |

The File System Access API is Chromium-desktop only — Firefox and Safari don't
implement the pickers, and Chrome for Android doesn't expose
`showDirectoryPicker`, though [work on Android and WebView is in
flight](https://issues.chromium.org/issues/40101963). It also can never hand a
file to the program that owns it; it only reads and writes bytes.

Tauri was chosen because it is the only one that answers portable, mobile and
real-files at once, and because it uses the OS webview — so the UI in `src/`
runs unmodified in both a browser tab and a native window.

## How that shows up in the code

One interface, `src/platform/platform.js`, describes what an environment can
do. Two adapters implement it:

- `src/platform/browser.js` — File System Access where available, download and
  upload where not. Paths are recorded but inert.
- `src/platform/tauri.js` — talks to the Rust commands in
  `src-tauri/src/lib.rs`.

Everything else asks `platform.can.realPaths` rather than sniffing for a native
runtime, so the UI hides what it cannot do instead of offering dead buttons, and
a third environment later means writing one adapter.

Two decisions keep the two builds from drifting apart:

**No bundler.** The frontend still has no build step and no dependencies. The
native build reaches Rust through the global `invoke` that Tauri's
`withGlobalTauri` provides, rather than the `@tauri-apps/api` npm package, so
there is no import that resolves in one environment and not the other. The
exact same files are served to a browser tab and embedded in the binary. `npm`
is present only to run the Tauri CLI; nothing in `src/` imports from
`node_modules`.

**File I/O is `std::fs` in our own commands, not `tauri-plugin-fs`.** That
plugin exists to grant a page a scoped slice of the disk. The point of this app
is referring to files wherever they actually are, so a scope would be a lie —
and a lie that produced confusing "permission denied" errors for paths the user
can plainly see in their own file manager. The frontend is first-party code
shipped inside the same binary, so the trust boundary is the app, not the page.
The consequence is worth stating plainly: **this app can read and write any file
your user account can.** It only does so when you point it at something.

## Portable file references

A path is a fact about one machine; a map is a thing you carry between
machines. `/home/dan/notes.md` is `/Users/dan/notes.md` on the laptop, and
plenty of files exist on exactly one device.

`src/core/locators.js` handles this in two halves.

**Named roots — the good case.** The document declares a root, say `sync`
meaning "the cloud drive folder". Each machine records separately where that
root actually lives. A reference of `{ root: 'sync', path: 'projects/notes.md' }`
then resolves everywhere, because the machine-specific part was never written
into the map.

> Root **names** travel in the document. Root **paths** never do — they live in
> per-machine settings, next to the app's config.

This is the highest-leverage trick available: if the map file itself lives in
the synced folder, most references can be relative to it, and most links then
work on every machine without any per-device fiddling.

**Alternates — the honest case.** Some things really do live in one place. A
reference carries a list of locators, each optionally tagged with the machine it
belongs to, and resolution takes the first that exists here. The UI shows the
status of each:

| | |
| --- | --- |
| ● green | on this machine, openable |
| ● red | resolves to a path, but nothing is there |
| ○ hollow | names a root this machine has not mapped |

![the same file recorded in three places](desktop-files.png)

So on any given machine some links open and some don't, and the interface says
which — rather than presenting a button that fails when pressed.

## Syncing

Export/import through a cloud drive works today: the map is one JSON file, so
put it in the synced folder and open it from there on each machine.

**The risk worth knowing about** is editing the same map on two machines before
the drive has caught up. Every sync tool resolves that by picking a winner and
leaving the loser as a conflict copy, which for a single JSON file means one
side's edits sit in a file named `map (conflicted copy).json` rather than being
merged. Nothing here prevents that yet. Practical mitigations, cheapest first:

1. Save and let the drive settle before switching machines. Boring, and enough
   for one person most of the time.
2. Keep the map in git rather than a sync folder. Conflicts become real merges
   over readable JSON, and you get history for free.
3. Split the document into a file per node. Turns most conflicts into
   non-overlapping file writes that sync tools handle without help. It is a real
   format change, and the moment to make it is when conflicts actually start
   happening, not before.

A revision counter plus a "the file changed underneath you" check before
overwriting would catch the common case cheaply, and is the obvious next step
if this bites.

## Mobile

Tauri v2 [supports iOS and Android](https://v2.tauri.app/blog/tauri-20/), and
`src-tauri/src/lib.rs` has the mobile entry point, so `tauri android init` and
`tauri ios init` will generate the projects. **None of that has been built or
run**, and it needs an Android SDK/NDK or Xcode to try.

Beyond the toolchain, one thing will need designing rather than porting: on
mobile, "a path to a file" is not really the model. Android uses scoped storage
and content URIs through the Storage Access Framework; iOS uses app sandboxes
and security-scoped bookmarks via the Files app. Neither hands out stable
absolute paths.

The locator model already anticipates this — a locator is `{ root, path }` plus
a device tag, and nothing assumes `path` is a POSIX path. A mobile adapter would
add a root kind backed by a document-provider URI. The parts that need no
rethinking at all are the map itself, the filtering, and file references as
*records*: on a phone you would still see every note that mentions a file, and
still be told which ones this device can open.

The other thing that needs design work is touch: the canvas is currently
mouse-and-keyboard, with drag-to-link and a keyboard-first capture flow that has
no obvious finger equivalent.
