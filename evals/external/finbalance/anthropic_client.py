"""Anthropic Messages API adapter for the FinBalance benchmark harness.

The upstream harness (github.com/Devansh1105/finbalance) only ships an
OpenAI-compatible chat-completions client (`finbalance.benchmark.model.OpenRouterClient`).
FinBalance's ablation runner accepts any object that satisfies its `ChatClient`
protocol (`finbalance.benchmark.tools.ChatClient`): a `model` attribute plus
`complete(prompt, temperature=, max_tokens=, timeout=) -> (text, payload)` and,
for multi-turn ablations, `complete_messages(messages, ...)`. This module is that
object for Claude, so no upstream file is modified.

Differences from the OpenRouter client, all forced by the Claude Opus 5.5 API:

* `temperature` is accepted for interface compatibility and NOT sent. Opus 5.5
  rejects temperature/top_p/top_k with a 400, so decoding is the model default
  (the paper decoded at temperature 0).
* Thinking is always on for Opus 5.5 (`thinking={"type": "adaptive"}`; the
  disabled and budget_tokens forms are rejected). Depth is set with
  `output_config={"effort": ...}` (default here: "medium"). Thinking tokens count
  toward `max_tokens` and are billed as output tokens.
* Requests are streamed (`messages.stream(...).get_final_message()`) because
  `max_tokens` covers thinking plus the JSON answer and long requests would
  otherwise trip HTTP timeouts.
* The provider payload is mapped into the usage keys the harness sums
  (`prompt_tokens`, `completion_tokens`, `total_tokens`, `cost`); cost is computed
  from the published Opus 5.5 price list because the Messages API does not
  return a dollar cost.

Retries: the SDK retries 408/409/429/5xx and connection errors on the request
(`max_retries`). A transient failure after the stream has started is not covered
by the SDK, so `complete_messages` retries those (overloaded, 5xx, connection,
timeout) a bounded number of times. Anything else propagates and the harness
records it as an error row (scored as a failure).

The API key is read from the environment or a dotenv file and is never logged.
"""

from __future__ import annotations

import json
import os
import random
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import anthropic

# Claude Opus 5.5 list prices, USD per million tokens.
PRICES_PER_MTOK = {
    "input": 4.00,
    "output": 20.00,
    "cache_read": 0.20,
    "cache_write_5m": 5.00,  # 1.25x input
    "cache_write_1h": 8.00,  # 2x input
}

TRANSIENT_STATUS_CODES = {408, 409, 429, 500, 502, 503, 504, 529}


class BudgetExceeded(RuntimeError):
    """Raised before a call that could push total spend past the hard cap.

    `status_code = 402` makes FinBalance's ablation runner treat it as a fatal
    provider error (it stops the run and checkpoints) instead of scoring the
    record as a parse failure.
    """

    status_code = 402


def load_api_key(env_file: str | None) -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    if env_file:
        from dotenv import dotenv_values

        key = str(dotenv_values(env_file).get("ANTHROPIC_API_KEY") or "").strip()
        if key:
            return key
    raise SystemExit("ANTHROPIC_API_KEY is not set (export it or pass --env-file pointing at a dotenv file)")


def cost_from_usage(usage: dict[str, Any]) -> float:
    cache_creation = usage.get("cache_creation") or {}
    write_1h = int(cache_creation.get("ephemeral_1h_input_tokens") or 0)
    write_total = int(usage.get("cache_creation_input_tokens") or 0)
    write_5m = max(write_total - write_1h, 0)
    return (
        int(usage.get("input_tokens") or 0) * PRICES_PER_MTOK["input"]
        + int(usage.get("output_tokens") or 0) * PRICES_PER_MTOK["output"]
        + int(usage.get("cache_read_input_tokens") or 0) * PRICES_PER_MTOK["cache_read"]
        + write_5m * PRICES_PER_MTOK["cache_write_5m"]
        + write_1h * PRICES_PER_MTOK["cache_write_1h"]
    ) / 1_000_000


class SpendLedger:
    """Thread-safe, persistent record of every billed call, with a hard cap.

    Before each call the client reserves a worst-case cost (estimated input plus
    `max_tokens` of output). A call is refused when settled spend plus all open
    reservations would exceed the cap, so concurrent workers cannot overshoot it.
    """

    def __init__(self, path: str | Path, cap_usd: float) -> None:
        self.path = Path(path)
        self.cap_usd = float(cap_usd)
        self._lock = threading.Lock()
        self._reserved: dict[int, float] = {}
        self._next_token = 0
        self._spent = 0.0
        if self.path.exists():
            with self.path.open(encoding="utf-8") as handle:
                for line in handle:
                    if line.strip():
                        self._spent += float(json.loads(line).get("cost_usd", 0.0))

    @property
    def spent(self) -> float:
        with self._lock:
            return self._spent

    def reserve(self, amount: float, label: str) -> int:
        with self._lock:
            committed = self._spent + sum(self._reserved.values())
            if committed + amount > self.cap_usd:
                raise BudgetExceeded(
                    f"budget cap ${self.cap_usd:.2f} would be exceeded before {label}: "
                    f"spent ${self._spent:.4f}, reserved ${sum(self._reserved.values()):.4f}, "
                    f"next call worst case ${amount:.4f}"
                )
            token = self._next_token
            self._next_token += 1
            self._reserved[token] = amount
            return token

    def settle(self, token: int, row: dict[str, Any]) -> None:
        with self._lock:
            self._reserved.pop(token, None)
            self._spent += float(row.get("cost_usd", 0.0))
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, sort_keys=True) + "\n")

    def release(self, token: int) -> None:
        with self._lock:
            self._reserved.pop(token, None)


class AnthropicChatClient:
    """FinBalance `ChatClient` backed by the Anthropic Messages API."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str = "claude-opus-5-5",
        effort: str = "medium",
        ledger: SpendLedger,
        run_label: str = "",
        sdk_max_retries: int = 4,
        stream_retries: int = 2,
        cache_first_user_message: bool = False,
        min_timeout_seconds: float = 900.0,
    ) -> None:
        self.model = model
        # Recorded by the harness as `reasoning_effort` in evaluation.json.
        self.reasoning_effort = effort
        self.ledger = ledger
        self.run_label = run_label
        self.stream_retries = int(stream_retries)
        self.cache_first_user_message = bool(cache_first_user_message)
        self.min_timeout_seconds = float(min_timeout_seconds)
        self._client = anthropic.Anthropic(api_key=api_key, max_retries=int(sdk_max_retries))
        self._local = threading.local()

    # The harness sets this per record so ledger rows can be attributed.
    def set_record_context(self, record_id: str) -> None:
        self._local.record_id = record_id

    def complete(
        self,
        prompt: str,
        *,
        temperature: float = 0.0,
        max_tokens: int = 8192,
        timeout: int = 180,
    ) -> tuple[str, dict[str, Any]]:
        return self.complete_messages(
            [{"role": "user", "content": prompt}],
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )

    def complete_messages(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.0,  # not sent: Opus 5.5 rejects sampling parameters
        max_tokens: int = 8192,
        timeout: int = 180,
        tools: list[dict[str, Any]] | None = None,
    ) -> tuple[str, dict[str, Any]]:
        if tools:
            raise NotImplementedError("native tool calling is not wired for the Anthropic adapter")

        api_messages: list[dict[str, Any]] = [
            {"role": message["role"], "content": message["content"]} for message in messages
        ]
        if self.cache_first_user_message and api_messages and isinstance(api_messages[0]["content"], str):
            # Multi-turn ablations resend the full record prompt on every turn; one
            # breakpoint on it turns the re-reads into cache hits. Same tokens reach
            # the model, so outputs are unaffected.
            api_messages[0] = {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": api_messages[0]["content"],
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
            }

        record_id = getattr(self._local, "record_id", "")
        input_chars = sum(len(str(message["content"])) for message in messages)
        # Worst case: ~2.5 chars/token on numeric OCR text, full max_tokens of output.
        worst_case = (input_chars / 2.5) * PRICES_PER_MTOK["cache_write_5m"] / 1_000_000 + (
            int(max_tokens) * PRICES_PER_MTOK["output"] / 1_000_000
        )
        token = self.ledger.reserve(worst_case, f"{self.run_label}:{record_id}")
        started = time.monotonic()
        attempts = 0
        try:
            while True:
                attempts += 1
                try:
                    with self._client.messages.stream(
                        model=self.model,
                        max_tokens=int(max_tokens),
                        messages=api_messages,
                        thinking={"type": "adaptive"},
                        output_config={"effort": self.reasoning_effort},
                        timeout=max(float(timeout), self.min_timeout_seconds),
                    ) as stream:
                        message = stream.get_final_message()
                    break
                except (anthropic.APIConnectionError, anthropic.APITimeoutError) as exc:
                    if attempts > self.stream_retries:
                        raise
                    self._backoff(attempts, exc)
                except anthropic.APIStatusError as exc:
                    if exc.status_code not in TRANSIENT_STATUS_CODES or attempts > self.stream_retries:
                        raise
                    self._backoff(attempts, exc)
        except BaseException:
            self.ledger.release(token)
            raise

        usage = message.usage.to_dict() if message.usage is not None else {}
        cost = cost_from_usage(usage)
        latency = round(time.monotonic() - started, 3)
        input_total = (
            int(usage.get("input_tokens") or 0)
            + int(usage.get("cache_read_input_tokens") or 0)
            + int(usage.get("cache_creation_input_tokens") or 0)
        )
        output_tokens = int(usage.get("output_tokens") or 0)
        self.ledger.settle(
            token,
            {
                "ts": datetime.now(timezone.utc).isoformat(),
                "run": self.run_label,
                "record_id": record_id,
                "turn": sum(1 for m in messages if m["role"] == "user"),
                "model": message.model,
                "message_id": message.id,
                "stop_reason": message.stop_reason,
                "input_tokens": int(usage.get("input_tokens") or 0),
                "cache_read_input_tokens": int(usage.get("cache_read_input_tokens") or 0),
                "cache_creation_input_tokens": int(usage.get("cache_creation_input_tokens") or 0),
                "output_tokens": output_tokens,
                "cost_usd": round(cost, 6),
                "latency_seconds": latency,
                "attempts": attempts,
            },
        )

        text = "".join(block.text for block in message.content if block.type == "text")
        payload = message.to_dict()
        # Opaque thinking signatures are large and useless for scoring; keep their size only.
        for block in payload.get("content", []):
            if isinstance(block, dict) and block.get("type") == "thinking" and "signature" in block:
                block["signature"] = f"<{len(str(block['signature']))} chars omitted>"
        numeric_usage = {key: value for key, value in usage.items() if isinstance(value, (int, float))}
        payload["usage"] = {
            **numeric_usage,
            "prompt_tokens": input_total,
            "completion_tokens": output_tokens,
            "total_tokens": input_total + output_tokens,
            "cost": round(cost, 8),
            "api_attempts": attempts,
            "api_latency_seconds": latency,
        }
        payload["finbalance_adapter"] = {
            "provider": "anthropic",
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self.reasoning_effort},
            "temperature_requested_by_harness": temperature,
            "temperature_sent": None,
            "max_tokens": int(max_tokens),
            "prompt_cache_breakpoint_on_first_user_message": self.cache_first_user_message,
            "stop_details": payload.get("stop_details"),
        }
        return text, payload

    @staticmethod
    def _backoff(attempt: int, exc: Exception) -> None:
        delay = min(60.0, 5.0 * (2 ** (attempt - 1))) + random.uniform(0, 2)
        print(f"[anthropic] transient error ({type(exc).__name__}: {str(exc)[:160]}); retrying in {delay:.1f}s", flush=True)
        time.sleep(delay)
