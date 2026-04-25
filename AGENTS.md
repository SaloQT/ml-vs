## JavaScript REPL (Node)

- Use `js_repl` for Node-backed JavaScript with top-level await in a persistent kernel.
- `js_repl` calls must send raw JavaScript input, not JSON, quotes, or markdown fences.
- Use dynamic imports such as `await import("./src/simulation.js")`; top-level static import declarations are unsupported.
- Avoid direct access to `process.stdout`, `process.stderr`, and `process.stdin`; use `console.log`, `codex.tool(...)`, and `codex.emitImage(...)`.

## Parallel Agent Isolation

- The main checkout is `/coding/ml-vs`.
- Use sibling git worktrees under `/coding/ml-vs-agent-worktrees/` for parallel agents.
- Do not edit the main checkout and an agent worktree for the same task at the same time unless the branches and touched files are intentionally disjoint.
- Before merging an agent branch, review its diff from the main checkout.
