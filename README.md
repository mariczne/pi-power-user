# pi-power-user

Powerline status bar and power-user toolkit for the
[pi](https://github.com/earendil-works/pi) coding agent.

Independent fork of [pi-powerline-footer][upstream], expanded with a shortcut
palette, subscription quota windows, and provider-aware model labels. Working
Vibes have been removed.

[upstream]: https://github.com/nicobailon/pi-powerline-footer

## Installation

```bash
pi install npm:@mariczne/pi-power-user
```

Restart pi to activate. Requires pi 0.81 or newer.

## Features

**Powerline status bar** — Configurable segments (model, thinking, path, git,
context, tokens, cost, queue, …) with preset layouts and separators. Nerd Font
auto-detection for iTerm, WezTerm, Kitty, Ghostty, Alacritty, and Kaku with
ASCII fallbacks. Custom items via `powerline.customItems`.

**Native pi layout** — pi owns the fixed input, transcript scrolling,
selection, and copy (fullscreen is pi's default TUI mode since 1.0). This
extension supplies the powerline rows plus the bash, stash, queue, and editor
integrations. The old extension-owned fixed editor has been removed; use pi's
`tuiMode` setting instead.

**Shortcut palette** — `/powerline shortcuts` or `ctrl+shift+k` opens a
searchable command palette listing the active Powerline bindings (prefixed
`Powerline: `) alongside standard pi keybindings. Type to fuzzy-search, press
enter to run the highlighted action. Editor keybindings are included as
searchable reference entries; bindings scoped to pi's modal selectors (tree
view, session picker, model selector) are omitted since those UIs show their
own hints. Configure or disable the key through `powerlineShortcuts.showShortcuts`.

**Editor stash** — Press `Alt+S` (or `Ctrl+S` while the editor has focus) to
save your editor content and clear the editor, type a quick prompt, then press
it again with an empty editor to restore the stash. Stashes are restored only by
explicit action. Stash history persists to disk and is browsable via
`/stash-history` or `ctrl+alt+h`.

**Sticky bash mode** — Toggle bash mode with `ctrl+shift+b` or `/bash-mode`. It
keeps a managed shell session alive for the current pi session, shows a
dedicated `shell_mode` segment, streams command output into an embedded
transcript below the editor, and lets `cd` or exported state persist across
commands. Ghost suggestions are opt-in via `bashMode.completions: true`.

**Powerline Queue** — Messages typed during compaction are held and delivered
after successful compaction. `/queue` manages queued prompts (aliases, retries,
clears, manual delivery); the `queue` segment shows active and blocked counts
only when there is something to show.

**Quote replies** — `/reply` inserts a previous user or assistant message as a
Markdown quote while keeping the current draft.

**Session directory switching** — `/cd <path>` continues the current
conversation from another working directory, keeping pi tools and the footer
path segment in sync.

**Delayed send and auto follow-up** — Optional: hold outgoing prompts for
`powerline.sendDelayMs` so `Esc` can pull them back, and let TypeSafe's Jev
route busy-agent messages to the follow-up queue with `powerline.autoFollowUp`.
Both are off by default.

**Live thinking level indicator** — Shows current thinking level
(`think:off`, `think:med`, etc.) with per-level colors. `xhigh` and `max` use a
rainbow effect; `high` uses the normal `thinkingHigh` theme color. Override any
level with `thinkingHigh`, `thinkingXhigh`, and `thinkingMax` in `theme.json`.

**Subscription quota windows** — When the active model has a supported
subscription usage source, the `cost` segment shows live usage windows instead
of a bare `(sub)`. Supported providers: `anthropic`, `openai-codex`, and
`opencode-go`. Anthropic/OpenAI usage is fetched through model-registry auth.
Opencode Go scrapes the dashboard and requires `OPENCODE_GO_WORKSPACE_ID` plus
`OPENCODE_GO_AUTH_COOKIE`; monthly usage is intentionally ignored for now. Usage
is cached for 2 minutes (30s on error). Set `powerline.cost.subscriptionDisplay`
to `"reported-cost"` for the reported dollar cost or `"both"` for cost plus the
subscription/quota display. `powerline.cost.currency` converts reported cost
into another currency.

**Provider shown next to the model** — By default the `model` segment appends
the active provider in parentheses (e.g. `Sonnet 4 (anthropic)`). Set
`powerline.model.display` to `"name"` to suppress it or `"qualified"` to show
the canonical provider-qualified ID (e.g. `anthropic/claude-sonnet-4`).

**Context awareness** — Color-coded warnings above 70% (yellow) and above 90%
(red) context usage. The context segment refreshes from live assistant usage
during streaming, and shows a `~` estimate after compaction or reload until the
next response arrives. Auto-compact indicator when enabled. If
`pi-custom-compaction` is installed and enabled, native context segments are
hidden so the footer does not show stale post-summary usage.

**Git integration** — Async status fetching with 1s cache TTL, scoped to the
active session's directory. Automatically invalidates on file writes/edits.
Shows branch, staged (+), unstaged (*), and untracked (?) counts. Polling runs
with `GIT_OPTIONAL_LOCKS=0` so it never takes `.git/index.lock`.

**Welcome overlay** — Branded splash screen shown as centered overlay on
startup. Shows gradient logo, model info, keyboard tips, loaded
AGENTS.md/skills/templates counts, an approximate initial system-prompt token
count, and recent sessions. Auto-dismisses after 30 seconds or on any key press.
**Off by default**; set `powerline.welcome: true` to enable it.

## Usage

Activates automatically. Toggle with `/powerline`, switch presets with
`/powerline <name>`, primary-row placement with `/powerline placement
above|below|toggle`, and the shortcut palette with `/powerline shortcuts`.

| Preset | Description |
|--------|-------------|
| `default` | Model, thinking, path (basename), git, context, tokens, cost |
| `minimal` | Just path (basename), git, context |
| `compact` | Model, git, cost, context |
| `full` | Everything including hostname, time, abbreviated path |
| `nerd` | Maximum detail for Nerd Font users |
| `ascii` | Safe for any terminal |

**Environment:** `POWERLINE_NERD_FONTS=1` to force Nerd Fonts, `=0` for ASCII.

Queue commands:

- `/compact <text>` — compact now and queue `<text>` as the next prompt (set
  `powerline.queue.compactPromptMode: "native"` to pass `<text>` to pi as
  compaction instructions instead)
- `/queue` — open the queued-prompt picker
- `/queue alias <name> [path]`, `/queue send [id]`, `/queue retry [id]`,
  `/queue clear <id|all>`, `/queue target <id> @name|global|current`

## Configuration

Set it in the agent settings file (`~/.pi/agent/settings.json` by default, or
under `PI_CODING_AGENT_DIR`) or project-local `.pi/settings.json`:

```json
{
  "showLastPrompt": true,
  "powerline": {
    "preset": "default",
    "separator": "chevron",
    "placement": "above",
    "welcome": false,
    "secondaryOverflow": "drop",
    "sendDelayMs": 0,
    "autoFollowUp": false,
    "customItems": [
      {
        "id": "ci",
        "statusKey": "ci-status",
        "position": "right",
        "prefix": "CI",
        "color": "warning"
      }
    ],
    "layout": {
      "left": ["model", "thinking", "path", "git"],
      "right": ["context_pct", "cost"],
      "secondary": ["custom:ci"]
    },
    "disabledSegments": [],
    "path": { "mode": "basename" },
    "model": { "display": "name" },
    "cost": { "subscriptionDisplay": "subscription", "currency": "USD" },
    "git": { "polling": "full" }
  }
}
```

`"placement"` accepts `"above"` (default) or `"below"`. It moves only the
primary powerline row. Set `"showLastPrompt": false` at the top level of
`settings.json` (not inside `powerline`) to hide the last-prompt reminder.

`"layout"` overrides segment order and grouping per preset row. A present
`left`, `right`, or `secondary` array replaces that preset group exactly; an
empty array clears it. Omitted groups keep the preset entries and automatically
append custom items by their configured `position`. `disabledSegments` is
applied after layout. Set `"separator"` to any documented separator style to
override the preset's separator independently. Set `"secondaryOverflow":
"wrap"` to continue secondary segments onto extra rows on narrow terminals
instead of dropping them.

Custom items accept `selfColorize: true` to keep ANSI colors already embedded in
the extension status instead of applying `color`.

Segment display formats are opt-in; defaults preserve the existing rendering:

| Segment option | Values | Default | Effect |
|---|---|---|---|
| `"context": { "format" }` | `"full"` / `"percent"` | `"full"` | Shows full token usage or a bare rounded percentage |
| `"cache_read": { "format" }` | `"tokens"` / `"percent"` / `"both"` | `"tokens"` | Shows raw tokens, cache hit rate, or both |

Set `"git": { "hostIcon": true }` to replace the branch icon with the detected
origin host logo (GitHub, GitLab, Bitbucket, or generic git). ASCII setups and
repositories without an origin retain the regular branch icon.

### Shortcut configuration

```json
{
  "powerlineShortcuts": {
    "showShortcuts": "ctrl+shift+k",
    "stashHistory": "ctrl+alt+h",
    "copyEditor": "ctrl+alt+c",
    "cutEditor": "ctrl+alt+x",
    "queueOpen": "ctrl+alt+q",
    "reply": null,
    "editorStart": "cmd+shift+up",
    "editorEnd": "cmd+shift+down"
  }
}
```

Set a binding to `null` or `""` to disable that action. After changing bindings,
run `/reload`. Invalid bindings, reserved key conflicts (like `Alt+S`), or
duplicate conflicts automatically fall back to safe defaults.

### Bash mode configuration

```json
{
  "bashMode": {
    "toggleShortcut": "ctrl+shift+b",
    "completions": false,
    "transcriptMaxLines": 2000,
    "transcriptMaxBytes": 524288
  }
}
```

### Subscription cost display

| Mode | Subscription + reported cost | Subscription + no reported cost |
|------|------------------------------|----------------------------------|
| `subscription` | `(sub …)` | `(sub …)` |
| `reported-cost` | `$0.12` | `(sub …)` |
| `both` | `$0.12 (sub …)` | `(sub …)` |

`…` is the live quota summary when the provider supports it.

### Data files

Stash history, bash history, queue state, and currency-rate caches live under
`pi-power-user/` in the agent dir.

### Theme overrides

Create `extensions/powerline-footer/theme.json` in the agent dir (`~/.pi/agent`
by default, or `PI_CODING_AGENT_DIR` when set). The agent-dir override is loaded
before a `theme.json` colocated with the installed package. Use `/reload` or
restart pi after editing it. See `theme.example.json` for available colors and
icons.

## Divergence from upstream

This package is an independent fork of [pi-powerline-footer][upstream] and is
periodically merged with it. Key divergences:

- **Shortcut palette** — `/powerline shortcuts` or `ctrl+shift+k` opens a
  searchable command palette blending Powerline bindings with standard pi
  keybindings.
- **Subscription quota windows** — The `cost` segment shows live usage windows
  for `anthropic`, `openai-codex`, and `opencode-go` subscriptions.
- **Provider shown next to the model** — The `model` segment appends the active
  provider in parentheses by default.
- **Welcome is opt-in** — The startup welcome overlay/header is off by default.
  Set `powerline.welcome: true` to turn it back on. (Upstream defaults it on.)
- **Thinking-level styling** — `high` uses the normal `thinkingHigh` theme
  color by default; only `xhigh` and `max` default to rainbow. Upstream applies
  rainbow to `high` too.
- **Working Vibes removed** — The `/vibe` command and the `working-vibes.ts`
  module have been removed. The "Working…" status text is no longer themed.
- **Separate data directory** — Persistent state lives under `pi-power-user/`
  instead of `powerline-footer/`, so both packages can coexist.

## License

MIT

## Author

Original author: Nico Bailon. Independently maintained by [@mariczne](https://github.com/mariczne).
