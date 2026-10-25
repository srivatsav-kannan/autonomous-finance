# Vendored DABstep scorer

Copied byte-for-byte from the DABstep leaderboard Space,
<https://huggingface.co/spaces/adyen/DABstep>, revision `d4431c2e4a695cbe43c33aab2adaa304a37ae64a`
(retrieved 2026-10-24). No changes were made; the empty `__init__.py` files mirror the upstream package.

| File | sha256 |
|---|---|
| `dabstep_benchmark/evaluation/scorer.py` | `229c04ecaa249ccc5b555dee11c85fe93d073d41eee61b6c3584065ae33c9df3` |
| `dabstep_benchmark/utils.py` | `7fc9bd01c9665c773c13bdbbf562b5f3bd91b422a191f7c49db9c2386eff0362` |
| `dabstep_benchmark/tests/test_scorer.py` | `664c6979790341f7ffafbcde9ad8e711148f3006ee42c0c28716e86a65743d9d` |

`utils.evaluate()` is the function the leaderboard and the official baseline use to score answers;
it calls `scorer.question_scorer(agent_answer, ground_truth)`.

Run the upstream tests (48 cases) from this directory:

```bash
uv run --no-project --with pytest --with pandas python -I -m pytest -q -p no:cacheprovider dabstep_benchmark/tests
```

License: DABstep: Data Agent Benchmark for Multi-step Reasoning © 2025 by Alexander David Egg,
Martin Iglesias Goyanes, Andreu Mora, Friso H. Kingma, Thomas Wolf, Leandro Von Werra, licensed
under CC BY 4.0 (<https://creativecommons.org/licenses/by/4.0/>). See `LICENSE`.
