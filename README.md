# clawd-cartoons

A Claude Code mod that replaces the spinner with live cartoons of what the agent is doing, drawn by Sonnet.

While Claude works, a strip under the spinner line shows Clawd, a small coral crab, acting out the current step: sitting by a campfire while the tests run, digging for a `grep`, hammering away at an edit. Each scene is written by Sonnet 5.5 as a few layers plus a little program, and runs at 20 frames a second in a sandboxed interpreter inside the mod.

<!-- PLACEHOLDER: GIF of the spinner during a real session goes here. Not recorded yet. -->
> **[GIF placeholder]** A recording of a real session will go here.

Inspired by [Anshu's tweet](https://x.com/anshuc/status/2105773281936650247) (@anshuc), which showed the idea: "I vibe-coded my own spinner that watches what the main agent is doing and uses Sonnet 5.5 to turn it into little cartoons in real time". Anshu didn't share the code, so this is an independent implementation written from the Claude Code mod docs. Thanks for the idea!

## Install

In Claude Code:

```
/plugin marketplace add falkoro/clawd-cartoons
/plugin install clawd-cartoons@clawd-cartoons
```

Cartoons start with your next turn. The first scene for each kind of work takes a few seconds to draw; until then you see the normal spinner.

To try a checkout without installing it: `claude --plugin-dir plugins/clawd-cartoons`.

## Configure

Open `/plugin`, pick clawd-cartoons, and change any of these:

| Option | Default | What it does |
| --- | --- | --- |
| Draw cartoons (`enabled`) | on | Off gives you the normal spinner and makes no model calls |
| Model (`model`) | `claude-sonnet-5-5` | The model that draws scenes: an alias such as `sonnet` or `haiku`, or a full model id |
| Seconds between requests (`min_seconds_between_requests`) | 20 | The shortest gap between two new scenes |
| Scenes per activity (`scenes_per_activity`) | 3 | How many scenes are kept for each kind of work. Once a kind has this many, it is never drawn again |
| Scene height (`scene_rows`) | 8 | Rows of cartoon under the spinner, 4 to 16 |
| Reply token limit (`max_reply_tokens`) | 16000 | The most tokens one scene may use |
| Effort (`effort`) | low | How hard the model thinks about each scene |

The `/cartoons` command shows what the mod has done this session: requests, tokens, scenes reused and the last error. It also takes these arguments:

- `/cartoons off` turns cartoons off for the rest of the session.
- `/cartoons on` turns them back on.
- `/cartoons clear` forgets every saved scene.

## How it works

1. **Watching.** The mod listens to `turn.start`, `prompt.submit` and `tool.call`, and sorts each step into a coarse kind of work: thinking, reading, editing, searching, running tests, building, git, web, a helper agent, an MCP server, and so on.
2. **Asking.** When the kind of work changes, the mod first shows a saved scene for it if there is one. If that kind has fewer than `scenes_per_activity` saved scenes, it also asks the model for a new one.
   - Requests are debounced by 1.5 s, so a burst of tool calls makes one request.
   - Requests are at least `min_seconds_between_requests` apart.
   - After an API error, requests back off from 30 s, doubling up to 10 minutes.
   - The call goes through `$.model.complete`, using the session's own credentials.
3. **Checking.** The reply is parsed, and the scene runs for a few test frames before it is shown. A scene that crashes or runs out of steps is never shown. Its error is sent back to the model with the next request.
4. **Drawing.** The Spinner render site (`ui.render` on `Spinner`) keeps the normal spinner line and adds a `Raster` below it.
   - A 50 ms timer draws each frame and repaints the Raster in place with `$.ui.blit`, without re-rendering the transcript.
   - The terminal is the only surface with a Raster. On the desktop, and whenever there is no scene, the spinner is left alone.
5. **Saving.** Scenes are saved in `$.store`, which is shared across sessions. Up to 40 are kept: `scenes_per_activity` for each kind of work, with the oldest dropped first.

<!-- PLACEHOLDER: screenshot of a scene with a code layer (e.g. the campfire) goes here. Not captured yet. -->
> **[Screenshot placeholder]** A screenshot of a running scene will go here.

### What a scene is

The model replies with a JSON block and, usually, a program:

````
```json
{
  "caption": "running the tests by the campfire",
  "sky": ["#0b1026", "#2a1830"],
  "ground": { "color": "#4a3a2a", "glyph": "▁" },
  "particles": [{ "glyph": "·", "color": "#8fa3ff", "count": 14, "vx": -1, "vy": 0 }],
  "actors": [{ "clawd": true, "x": 2, "vx": 3, "wrap": false }],
  "say": { "text": "{doing}", "x": 2, "y": 0 }
}
```
```js
function draw(t) { /* paint the fire */ }
```
````

Layers draw in this order:

1. sky gradient
2. ground row
3. drifting particles
4. **the program**
5. sliding actors (Clawd walks and blinks on its own)
6. the speech bubble

In the bubble, `{doing}` becomes the current step, such as "running npm test", so one saved scene still fits each new step.

### The scene language

Programs are written in a small subset of JavaScript and run by a tree-walking interpreter in [`hooks/lang.ts`](plugins/clawd-cartoons/hooks/lang.ts). Mods can't `eval`, and running model-written code in a separate process would be unsafe. An interpreter can be stopped at any step and can only reach what it is given.

**Supported:**
- `let`, `const` and `var`; functions and arrows with default parameters
- `if`, `for`, `for…of`, `for…in`, `while`, `do`, `switch`, `break`, `continue` and `return`
- objects with shorthand and methods, arrays, template strings, and flat destructuring
- the usual operators
- whitelisted array and string methods
- `Math` (with a seeded `random`), `Array.from`, `Object.keys`/`values`/`entries`, `String`, `Number`, `parseInt` and `parseFloat`

**Not supported:** `new`, classes, `this`, `try`/`throw`, async code, regex, spread, `?.` and imports. Each of these gets an error message that suggests what to write instead.

**How a program runs:**
- Top-level code runs once.
- After that, `draw(t)` runs every frame. A program with no `draw` re-runs whole each frame.
- Globals: `W`, `H`, `t`, `frame`, and `doing` (the current step as text).

**Drawing**, in cells where x grows right and y grows down:

| Call | Draws |
| --- | --- |
| `put(x, y, ch, fg?, bg?)` | one cell |
| `text(x, y, str, fg?, bg?)` | a line of text |
| `sprite(x, y, "multi\nline", fg?, bg?)` | ASCII art; spaces are see-through |
| `fill(x, y, w, h, bg?, ch?, fg?)` | a rectangle |
| `line(x0, y0, x1, y1, ch?, fg?)` | a line |
| `circle(x, y, r, ch?, fg?)` | an outline |
| `disc(x, y, r, color)` | a solid disc in half-cell pixels, so it looks round |
| `pixel(x, py, color)` | one half-cell pixel; `py` counts half rows |
| `clawd(x, y, facing, stride, blink)` | Clawd |
| `say(text, x, y)` | a speech bubble |

Every cell takes its own foreground and background color, so a program can paint full shaders.

Helpers: `hsl`, `rgb`, `mix`, `noise`, `noise2`, `smoothstep`, `rand` and `clamp`.

Only one-cell-wide characters are drawn. Emoji and other wide characters become `?`, so the terminal grid never breaks.

## Safety model

The model writes code after seeing what your agent is doing, so that code is treated as untrusted.

- **No eval and no processes.** The program is parsed and walked by the interpreter. It never becomes JavaScript the host runs, and no child process is started.
- **Nothing to reach.** A program sees only its own values and the functions listed above.
  - Property reads return only an object's own data, so `constructor`, `__proto__` and prototypes give `undefined`.
  - Functions have no properties, and methods can't be taken off and stored.
  - Assigning to a built-in only shadows it for that program.
- **A step budget.** Every statement and expression costs a step, and drawing costs a step per cell touched.
  - One frame gets 300,000 steps; setup gets 1,000,000. Going over stops the program with an error.
  - This catches infinite loops and runaway work.
- **Memory bounds.**
  - Arrays are capped at 10,000 items and strings at 10,000 characters.
  - One frame may create at most 200,000 items and characters.
  - Calls may nest at most 64 deep, which catches unbounded recursion.
  - A program that keeps creating things re-runs its setup instead of growing forever.
- **Errors go back to the model.** A scene that fails is switched off. The error, as `line N: message`, is sent with the next request so the model can fix it.
- **Cheap frames.** A full-width shader covering every cell of a 200 × 8 strip takes about 1–2 ms a frame on Node 26 (see the timing test in `tests/scene.test.ts`). A frame at 20 fps has 50 ms.

**Privacy:** each request sends the model a few short pieces of text:
- the current step, such as a command line or a file name
- the last few steps
- the first 200 characters of your latest prompt

They go through Claude Code's own API client, under the same account and model terms as the rest of your session. No file contents are sent.

## Cost

Each new scene is one request. It costs about 1,500–2,000 input tokens (mostly the fixed instructions) and, typically, 1,000–3,000 output tokens. `max_reply_tokens` caps each reply.

What keeps the cost down:
- **At most one request every 20 seconds** while Claude works, and none between turns.
- **Saved scenes are free.** Once a kind of work has `scenes_per_activity` scenes (3 by default), it is never drawn again; the saved scenes rotate instead. After a few sessions, most turns make no requests at all.
- **Seeing what was spent:** `/cartoons` shows this session's tokens.

**To spend less**, any of these helps:
- pick a cheaper model, such as `haiku`
- raise the seconds between requests
- lower the scenes per activity

**To spend nothing**, do any of these:
- turn off "Draw cartoons" in `/plugin`
- run `/cartoons off` for the current session
- disable the plugin entirely in `/plugin`, or with `claude plugin disable clawd-cartoons`

## Develop

```
claude plugin validate plugins/clawd-cartoons --strict
claude plugin test plugins/clawd-cartoons
```

The tests cover:
- the interpreter: budgets, recursion, memory limits, bad programs, and the sandbox
- every drawing primitive and the Raster encoding
- reply parsing
- the mod against a stubbed engine: the spinner fallback, debouncing, the request gap, the scene cache, error feedback, `/cartoons` and the options

CI runs the same commands.

## License

MIT. The Clawd crab here is original pixel art drawn for this mod.
