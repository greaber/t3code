# Terminal history

Each terminal keeps up to 1,000,000 lines and 256 MiB of scrollback on its
environment server. T3 Code removes the oldest output when either limit is
reached. A long line can be shortened at the start. New terminal output is not
truncated. To change the limits, set `T3CODE_TERMINAL_HISTORY_MAX_LINES` or
`T3CODE_TERMINAL_HISTORY_MAX_BYTES` in the environment that starts the server.

When you open or reconnect to a terminal, it shows the most recent output first.
On web and desktop, scrolling to the top loads earlier output. On iPhone, iPad,
and Android, choose **Load earlier output** in the terminal menu. Each client
holds up to 8 MiB or 100,000 rows of a terminal's output; earlier output stays
on the server.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all output the client holds, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

On iPhone and iPad, long-press the terminal to paste or to choose Select Text.
Select Text shows the visible output, where you can copy text or tap a link.

## fish

T3 Code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3 Code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3 Code. A shell export applies
when you launch T3 Code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
