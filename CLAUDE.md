# Project Context & Rules for Claude

## Repository Identity & Context

The project-specific identity, runtime environments, folder layouts, business logic, and technical requirements are documented in the repository's root `README.md`. Always read it first to understand the context of the workspace.

---

## Rules You Must Always Follow

1. **Read README files first — before writing or modifying any code.**
   The root `README.md` and any subfolder-specific `README.md` files are the single source of truth for the project's tech stack, architecture, folder structure, hardcoded values, and quirks.

2. **Respect repository structure.**
   Follow the project folder structure defined in the README. If the repository contains separate projects or subfolders, treat them as completely isolated context boundaries and never conflate dependencies, scripts, configurations, or boundaries across them.

3. **Adhere strictly to the defined tech stack.**
   Write code that is fully compatible with the runtime, libraries, coding standards, and syntax constraints specified in the README (e.g., target language versions, environment restrictions, and APIs). Do not introduce unauthorized runtimes or external dependencies.

4. **Dependency Management.**
   Only manage, install, or reference dependencies at the directories specified in the project README. Do not initialize dependency folders (like `node_modules`, `venv`, etc.) inside sub-packages or subfolders unless explicitly instructed.

5. **Use project tooling and scripts.**
   Always use the defined build, test, lint, and deployment scripts (e.g., scripts in `package.json`, `Makefile`, etc.) from the workspace root or target paths as documented in the README. Do not execute deployment, execution, or build commands directly unless instructed.

6. **Security & Testing:** Prioritize security and input validation. Walk through test cases before proposing changes to avoid breaking interdependent scripts or workflows.

7. **Simplicity & Readability:** Implement the simplest code whenever possible to avoid spaghetti code and improve readability.

8. **Code Modularization:** Apply code modularization whenever possible for easier maintenance.

9. **Security Validation:** Check and validate on security sectors.

10. **Robust Debugging & Error Logs:** Always implement proper debug logs for troubleshooting. Wrap entry points, public API endpoints, database operations, and critical routines with clear parameter/input logs, and wrap execution blocks in try-catch to log detailed errors before propagating or re-throwing exceptions.

11. **Performance & Efficiency:** Always prioritize performance and efficiency when implementing code.

12. **Google Apps Script & Clasp Deployment Rules**:
    - The Script ID lives only in the local, gitignored `.clasp.json` (copy `.clasp.example.json`). The web app deployment ID lives only in the gitignored `.deploy.json` (copy `.deploy.example.json`).
    - This project operates in a single environment (no separate `dev` or `prod` environments).
    - Every development step/code change MUST always be deployed to Google Apps Script immediately using `npm run push` (clasp push plus an update of the existing web app deployment).

13. **Public Repository Secrets**:
    - This repository is public. Never commit IDs, tokens, URLs of the web app, spreadsheet IDs, emails or financial data.
    - Secrets live in Script Properties (`API_TOKEN`, `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `SPREADSHEET_ID`) or on each phone.

---

## Git Workflow

- Adhere strictly to the project's `.gitignore` rules.
- Review the list of modified and untracked files before staging changes.
- Ensure only source code files, configurations, and assets matching the project guidelines are committed. Avoid committing credentials, local configuration overrides, or large binary packages.
- The only branch is `master` (GitHub default). Every push to `master` that touches `web/` publishes the phone app to GitHub Pages.

---

## Repository Layout

- Root: the Apps Script files (flat, next to `appsscript.json`). Clasp pushes only these, through the `.claspignore` allowlist.
- `web/`: the phone PWA (vanilla ES modules, no build step), published to GitHub Pages. `web/` must never call `google.script.run`; it talks to the web app over HTTP only.
- `scripts/`: local tooling (the `npm run push` deploy helper).
- `.github/`: the Pages workflow and Dependabot config.
- The root Apps Script files must never be moved into subfolders, because clasp turns folder paths into file names and the by-name dialog lookups would break.
