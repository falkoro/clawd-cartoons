# Contributing

Feature requests and pull requests are welcome.

## Ideas and bugs

Open an issue with an idea for a scene, a step Clawd acts out badly, or a bug. These help:
- a screenshot of the panel
- what the agent was doing at the time
- your Claude Code version (`claude --version`)
- the output of `/cartoons`, which shows the last error

## Pull requests

`main` is protected, so every change goes through a pull request and needs the CI `test` check to pass.

1. Branch from `main`.
2. Try the change live: `claude --plugin-dir plugins/clawd-cartoons`.
3. Run the same two commands CI runs:
   ```
   claude plugin test plugins/clawd-cartoons
   claude plugin validate plugins/clawd-cartoons --strict
   ```
4. For a change to the prompt or the drawing, add before-and-after screenshots of a panel from a real session. A prompt change is hard to judge from the diff alone.

## Where things are

All the code is in `plugins/clawd-cartoons/hooks/`:

| File | What it does |
| --- | --- |
| `register.tsx` | The hooks: watching the agent, timing the requests, drawing under the spinner, `/cartoons` |
| `prompt.ts` | What the model is told: the style, the scene format, the example, and each request |
| `scene.ts` | Parsing a reply into a scene, and drawing it frame by frame |
| `canvas.ts` | The cell grid and the drawing primitives: pixels, Clawd, the bubble, labels |
| `lang.ts` | The sandboxed interpreter that runs the model's programs |

The tests are in `plugins/clawd-cartoons/tests/`. A change to `lang.ts` needs a test, since that file is what keeps the model's programs in their sandbox.

By contributing, you agree that your work is released under the [MIT License](LICENSE).
