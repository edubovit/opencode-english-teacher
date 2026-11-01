# opencode-english-teacher

Quiet English feedback for the OpenCode V2 terminal UI. Checks new user messages in the background and notifies you only when it finds useful corrections.

- Grammar, tenses, word choice, and noticeably unnatural phrasing.
- Up to five short corrections, in English. No praise, scores, or whole-message rewrites.
- A single correction is unnumbered; multiple corrections form a numbered list.
- One isolated message per request. No conversation history, repository instructions, tools, or attachments.
- Persistent correction history and an independent on/off setting for each session.

Analysis consumes additional model usage, including when no correction is returned. Text is sent to your selected model provider under its usual billing and retention policies.

## Install from a checkout

Use OpenCode 2.2.5 or a compatible V2 host. Development commands need Node 24 or newer; rendering tests use the project's bundled Bun.

In this repository:

```sh
npm ci --ignore-scripts
npm run build
```

Add the plugin **directory** to your global `opencode.json(c)` for all projects, or a project's `opencode.json(c)` for that project only. Replace the example directory with your checkout path. Do not point to an individual `.ts` file.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-english-teacher",
      "options": {
        "model": "openai/gpt-6.1-terra",
        "variant": "low"
      }
    }
  ]
}
```

This example selects GPT-6.1 Terra with low reasoning. The model and variant must be available in your OpenCode configuration. The plugin reuses host authentication; it requires no separate API key.

OpenCode watches configuration changes. Use `/reload` if necessary. The package includes both server and TUI entrypoints; do not register its TUI a second time in `cli.json`.

This repository does not publish or install a registry release automatically. To distribute a local package, use `npm pack`; the package exports the same server and TUI entrypoints.

## Use

Send a message normally. When corrections are ready, an in-app notification identifies the session. Open `/english`, or Ctrl+P → **English teacher**.

The view opens on the latest **commented** message, even if a newer message has no corrections.

| Key | Action |
| --- | --- |
| Page Up | Older commented message |
| Page Down | Newer commented message |
| Up / Down | Scroll the current comment |
| L | Open the commented-message list |
| T | Turn analysis on/off for this session |
| R | Refresh saved comments/status; does not rerun analysis |
| Escape | Close, or return from the message list |

In the list, Up/Down select a message and Enter opens it. Only commented messages appear, newest first. Opening menus never submits a prompt or changes the conversation.

Disabling cancels pending analysis but preserves saved comments. An already-authorized final write finishes before disabling is acknowledged. Re-enabling checks only future messages. Closing the view does not stop analysis. Settings and corrections survive reloads and restarts.

## Configuration

All options are optional. Omitting `options` enables analysis by default and inherits the session's model and reasoning variant.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabledByDefault` | `true` | Analysis state for sessions without an explicit on/off override |
| `model` | Session model | Model in `provider/model` format |
| `variant` | See below | Host-defined reasoning variant |

Model selection:

- No overrides: session model and variant.
- Model only: configured model with its default variant.
- Variant only: session model with the configured variant.
- Both: configured model and variant.

Set `"enabledByDefault": false` to require enabling analysis in each session. Explicit session choices survive changes to this default. Unknown or invalid options suspend analysis and display an error; they do not silently fall back.

## Customize the teacher

The server plugin creates `~/.config/opencode/english-teacher.md` with its default teaching instructions when the file is missing. If `XDG_CONFIG_HOME` is an absolute path, it uses `$XDG_CONFIG_HOME/opencode/english-teacher.md` instead. This is one global file shared across projects and sessions, on the machine running the OpenCode server—not necessarily the terminal client.

Edit the file to change the teacher's focus, strictness, wording, or explanation style. It is read before each analysis request; no restart is required. In-flight requests keep the instructions already sent, and saved comments are not reanalyzed. Existing files are never overwritten, including empty files. Delete the file to restore defaults on the next load or analysis.

Use nonblank UTF-8 text, at most 64 KiB. Invalid/unreadable files produce an analysis error in `/english`, not a silent fallback. The plugin still enforces isolated English input, its JSON response contract, at most five corrections, length limits, and UI numbering. Changing the file cannot enable tools or add conversation history. Do not put secrets in it: its contents are sent to the selected model provider. Project configuration and `OPENCODE_CONFIG_DIR` do not select a different teacher file.

## Boundaries

- Only new messages observed while the plugin is active and enabled are checked. No history backfill or replay of interrupted jobs.
- All child sessions are excluded, including human messages typed directly into them. OpenCode does not provide reliable human/programmatic attribution; automated prompts in root sessions may be checked.
- Other languages and obvious copied text, code, logs, and quotations are not correction targets. Unmarked pasted prose cannot reliably be distinguished from original writing.
- Comments describe the submitted text. Native undo does not rewrite teaching history. Forks start with their own settings and no copied teacher history.
- Analysis failures appear in `/english`, not as corrections. A failed request does not mean the English is correct.
- Each location runs at most two analyses at once, with 100 waiting jobs and a two-minute analysis deadline including queue time. Final persistence/cleanup is drained, not forcibly interrupted by that deadline. Messages over 64,000 UTF-16 characters are skipped with a visible status rather than silently truncated.
- Stateless generation is an experimental OpenCode API. Providers requiring session-specific request hooks may be incompatible. Unsupported models, variants, or authentication paths fail without model fallback or conversation-context leakage.
- Model choice is sampled when a message is observed. A simultaneous model change can race with the coding assistant's later selection.
- Corrections and short source previews remain in host plugin storage until session deletion is observed or reconciled. Provider usage already incurred cannot be cancelled or refunded by this plugin.

See [development and testing](docs/contributing/DEVELOPMENT.md) for test commands and implementation boundaries.
