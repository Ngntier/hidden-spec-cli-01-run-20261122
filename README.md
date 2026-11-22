# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ngntier/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ngntier/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It reads a patch in one of four
formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and text-editor tool calls as JSON — finds the lines each edit
names even when the model drifted their whitespace or indentation (three
matching tiers), and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--format=NAME` (`auto`, `unified`, `search-replace`, `v4a`, `json`),
`--check` (do everything but write), `--strict` (exact line matching only).
`PATCH` is the patch file, or `-`/absent to read the patch from standard
input. Node 22, standard library only; nothing is installed.

<sub>Entered on [make.fun](https://make.fun/?ref=t1h9wdbp&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
