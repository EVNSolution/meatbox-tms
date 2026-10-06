# Meatbox TMS

Read `.codex/skills/attention-kind/SKILL.md` once per chat for main-conversation reporting. Follow the project decisions and work-unit checklist in `docs/agent-tooling-setup.md`. Preserve existing execution and verification rules.

For implementation, read `.codex/skills/meatbox-work-unit/SKILL.md` and follow the fixed frontend-fork/API decision in `docs/new-stack-architecture.md`.

For commits, PRs, CI or deployment, read `.codex/skills/meatbox-delivery/SKILL.md` and follow `docs/delivery-workflow.md`. Deployment within the user's requested project work is already authorized; complete validation and deploy the configured TEST target without another permission handoff. Preserve data and environment boundaries. Use purpose-based commit prefixes (`Feat:`, `Fix:`, `Refactor:`, `CI:`, `Docs:` etc.); never use a `Codex` commit prefix. Keep Lore decision trailers. Run one CI pipeline per candidate and deploy its verified artifact without rebuilding it.
