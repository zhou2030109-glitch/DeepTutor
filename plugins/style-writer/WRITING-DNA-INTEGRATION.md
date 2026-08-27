# Writing DNA integration

The style-writer plugin vendors `writing-dna-skill` under
`vendor/writing-dna-skill` and adapts its workflow for DeepTutor's desktop
plugin boundary.

Upstream: https://github.com/larashero3-dotcom/writing-dna-skill
License: MIT (see `vendor/writing-dna-skill/LICENSE`)

## Local data layout

Each writing space owns a separate directory under:

```text
plugin-data/style-writer/dna/<space-id>/
├── corpus/                 # one JSON file per imported article
├── draft.json              # resumable AI-generated candidate
├── profile.json            # currently active, human-approved DNA
└── versions/               # immutable approved snapshots
```

Corpus and DNA files never enter DeepTutor's global memory. The compact
`state.json` only keeps UI state and a summary of the active version.

## Safety and workflow

- Corpus identity is separated into the user's own work and named reference
  authors/accounts. Different identities are never mixed in one distillation.
- Distillation creates five editable outputs: language, structure, cognitive
  framework, visual style, and the integrated `Writing-DNA.md`.
- AI-generated candidates require explicit approval before activation.
- Generation reads only the active profile plus up to five related source
  articles. Prompts explicitly prohibit copying facts, opinions, or sentences.
- The bundled `lieflat-less-ai-tone` rules are exposed as a separate,
  reversible post-processing action.
