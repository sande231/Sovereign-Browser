# Rules for working on Sovereign Browser
- Privacy first: never send prompts, answers, documents or chat history to any cloud AI or third-party API. AI must run locally (WebLLM/WebGPU). No silent cloud fallback.
- Every new network request must appear in the Privacy Receipt, labelled with its purpose.
- Never commit secrets: no .env, API keys, tokens or credential files.
- Keep changes small and focused on the task. Don't rewrite unrelated code.
- After each change, run `npm run check` and fix any failures.
- Explain what you changed, which files, and how to test it manually.
- Don't push to GitHub; Sandeep reviews and pushes.
- Teamwork: Claude Code writes PLAN and REVIEW, Codex writes CHANGES, in docs/HANDOFF.md. Never edit the other's section.
