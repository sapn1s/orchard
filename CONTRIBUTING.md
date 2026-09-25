# Contributing

Orchard is a personal project built for one person on one machine, developed in the open.
Contributions are welcome, with a light process to match its scope.

## Issues and pull requests

- Issues are welcome: bug reports, questions, and ideas.
- Please open an issue to discuss a change before sending a pull request, so we can agree on the
  approach before you spend time on it.

## Before you send a PR

Run the offline checks and make sure they pass:

```sh
npm ci                            # install from the committed lockfile
npm run typecheck                 # tsc --noEmit
node scripts/verify.ts --offline  # API + agent bridge, no model calls
npm run gate                      # the pre-commit leak-gate + typecheck
```

The full `npm run verify` pass calls the model and costs tokens, so it is not required for a PR.

## Licence

Contributions are accepted under the repository's licence, the
[PolyForm Noncommercial License 1.0.0](LICENSE).
