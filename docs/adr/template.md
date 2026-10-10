# ADR template

Use this template for one architectural proposal. Delete all instruction text
when you create the ADR.

Follow this lifecycle:

1. Create a small proposal ADR and link its issue.
2. Get agreement before implementation.
3. In the implementation pull request, move the current contract to the
   specification, guide, or implementation notes.
4. Delete the proposal ADR in that pull request.

Do not add a `Status:` field. Every ADR is a proposal. An implemented decision
does not belong in this directory.

Keep the ADR small:

- Target 30 to 80 lines.
- Wrap prose at 80 characters. Do not put multiple sentences on one long line
  to reduce the line count.
- If the ADR exceeds 100 lines, remove detail or split the decision.
- State one decision. Do not combine independent proposals.
- Show the exact public API or data shape when it is the decision.
- Include implementation detail only when the implementation structure is the
  architectural decision.
- Do not add speculative edge cases, tutorials, repeated rationale, or a long
  catalog of alternatives.
- Use short examples instead of long explanations.
- Do not start implementation before approval when the ADR is a proposal.

Use only the sections that help the decision.

```markdown
# <Decision title>

Issue: [#<number>](https://github.com/lucasavila00/github-webhook-relay/issues/<number>)

## Context

<In two to five sentences, state the current problem and why a decision is
needed. Do not summarize the full project.>

## Decision

<State the decision directly. Show the exact API, wire shape, or component
boundary when applicable. Include one or two short examples.>

## Consequences

<List only material compatibility costs, operational effects, or constraints.>

## Alternatives

<Optional. Include only serious alternatives that affect approval. Give each
alternative one short paragraph.>
```
