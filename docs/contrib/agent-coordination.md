# Autonomous Agent Coordination

Use these instructions when you coordinate autonomous work across multiple
agents. Move the requested work to review without unnecessary waiting.

- Define the complete acceptance criteria before implementation. Keep the
  active pull request within that scope. Create a separate issue for an
  unrelated finding.
- The root agent coordinates the work, defines the scope, tracks hosted CI,
  and reviews repository state. It must not create or edit repository files.
- Any subagent that creates or edits repository files must use the
  `gpt-5.6-sol` model. Give each implementation subagent the full task context.
- The runtime has four total agent slots. The root agent uses one slot, so
  three subagent slots are available.
- Use slots in short cycles. One subagent implements one issue, runs focused
  checks, pushes a complete draft pull request, reports its exact head commit,
  and then stops.
- The root agent tracks hosted CI and review without keeping the implementation
  subagent active. Immediately use the free slot for the highest-priority
  unblocked issue. Do not wait for the prior pull request to merge.
- Use a separate agent for the final independent review. Reviewer agents can
  use any available model. The main coordinating agent selects the reviewer
  model based on task risk, scope, and speed. The reviewer must remain
  independent from the implementer and must not edit the reviewed branch. The
  reviewer reports the result and then stops.
- Use hosted CI for full validation. Do not use an agent slot to wait for
  hosted CI.
- Do not merge `main` into a clean pull request only to refresh its ancestry.
  This repository squash-merges pull requests. Merge `main` only when GitHub
  reports a conflict, and preserve both sides of the conflict.
- Do not use a GitLab-style merge train that repeatedly merges the latest
  `main` into every open pull request. Review and test each clean pull request
  at its exact head. Run the full tests again on the combined `main` branch
  before publishing.
- Keep a pull request in draft while implementation, conflict resolution,
  review, or required CI is incomplete.
- Mark a pull request ready as soon as its requested scope is complete, its
  exact head has an independent review with no blocker, GitHub reports no
  conflict, and all required hosted checks pass.
- Rebuild the work inventory after a merge or a new issue changes priorities.
  Do not repeat the inventory while the external state is unchanged.
- Keep no more than six pull requests open at one time. Draft pull requests can
  outnumber active agents. Use open slots for the highest-priority unblocked
  issues.
