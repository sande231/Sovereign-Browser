# Rules for working on Sovereign Browser
- Privacy first: never send prompts, answers, documents or chat history to any cloud AI or third-party API. AI must run locally (WebLLM/WebGPU). No silent cloud fallback.
- Every new network request must appear in the Privacy Receipt, labelled with its purpose.
- Never commit secrets: no .env, API keys, tokens or credential files.
- Keep changes small and focused on the task. Don't rewrite unrelated code.
- After each change, run `npm run check` and fix any failures.
- Explain what you changed, which files, and how to test it manually.
- Don't push to GitHub; Sandeep reviews and pushes.
- Teamwork: Claude Code writes PLAN and REVIEW, Codex writes CHANGES, in docs/HANDOFF.md. Never edit the other's section.
- Never run git commit, git push or change git config. Sandeep makes all commits.
- Never add Co-Authored-By or any AI attribution lines to commit messages or pull requests.

## Approval gates (Phase 2 onward): STOP and wait for Sandeep's explicit "approved"
- After writing any PLAN, before any code is built.
- Before adding any new dependency, Docker image, download or external service.
- Before any change to network behaviour, the Offline allowlist, the sensitive-topic guard or the Privacy Receipt.
- Before any user-facing safety, crisis or legal text.
- Before marking a task DONE.
- When asking, give a short summary, the exact decision needed, and your recommendation. Never treat silence or a question as approval.
