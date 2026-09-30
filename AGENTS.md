# Project collaboration workflow

## Roles

- The primary Codex agent uses GPT-6 Astra to inspect the project, plan work, review changes, and run project verification when requested.
- Do not directly edit game or application source files as the primary agent. Delegate source edits to the project-local Claude worker after its doctor and smoke checks pass.
- The Claude worker may edit only paths explicitly granted for that task. Keep each task small and review its diff before accepting it.
- Limit a task to three worker attempts total. The primary agent reviews each result and may request at most two revisions.

## Safety and verification

- Never ask the worker to run shell commands. Its available tools are limited to project file reading and explicitly scoped editing; MCP servers are disabled.
- Do not disable Claude's restricted mode or use `--dangerously-skip-permissions`.
- Project instructions are behavioral guidance, not an operating-system security boundary. Review worker changes before using them.
- The primary agent runs builds and tests independently when the task calls for them. Report clearly when they were not run.
- Do not commit or push unless the user asks.
- Preserve existing user changes and unrelated files.
