import json
import structlog
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from src.pipelines.base import Pipeline, Stage, PipelineContext
from src.infrastructure.database.models import EmailThread, EmailMessage, TriageResult
from src.config.database import get_session_factory
from src.infrastructure.llm.llm_service import LLMService

logger = structlog.get_logger()

# ── Load categories from config JSON ──────────────────────────────────────────
_CATEGORIES_PATH = Path(__file__).parent.parent / "config" / "triage_categories.json"

def _load_categories() -> dict[str, Any]:
    with open(_CATEGORIES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def _build_system_prompt(categories_config: dict) -> str:
    cats = categories_config["categories"]
    default = categories_config["default_fallback"]
    category_lines = "\n".join(
        f"- {c['id']}: {c['description']}" for c in cats
    )
    valid_ids = ", ".join(c["id"] for c in cats)
    return (
        f"You are an AI assistant designed to triage emails.\n"
        f"Classify the given email into exactly one of the following categories:\n"
        f"{category_lines}\n\n"
        f"Valid category IDs: {valid_ids}\n"
        f"If uncertain, default to '{default}'.\n\n"
        f"Respond strictly with JSON:\n"
        f'{{ "classification": "<category_id>", "confidence": <0.0-1.0>, "reasoning": "<short explanation>" }}'
    )

def _build_batch_system_prompt(categories_config: dict) -> str:
    cats = categories_config["categories"]
    default = categories_config["default_fallback"]
    category_lines = "\n".join(
        f"- {c['id']}: {c['description']}" for c in cats
    )
    valid_ids = ", ".join(c["id"] for c in cats)
    return (
        f"You are an AI assistant designed to triage emails.\n"
        f"You will receive a numbered list of emails. Classify EACH ONE into exactly one category.\n\n"
        f"Categories:\n{category_lines}\n\n"
        f"Valid category IDs: {valid_ids}\n"
        f"If uncertain, default to '{default}'.\n\n"
        f"Return a JSON object with a 'results' array — one entry per email, in the SAME ORDER as the input:\n"
        f'{{"results": [{{"thread_index": 0, "classification": "<id>", "confidence": 0.9, "reasoning": "<short explanation>"}}, ...]}}'
    )

def _is_noreply(from_address: str) -> bool:
    lower = (from_address or "").lower()
    return "no-reply" in lower or "noreply" in lower or "do-not-reply" in lower


# ── Structured output schemas ──────────────────────────────────────────────────
class TriageResponse(BaseModel):
    classification: str
    confidence: float
    reasoning: str

class BatchTriageItem(BaseModel):
    thread_index: int
    classification: str
    confidence: float
    reasoning: str

class BatchTriageResponse(BaseModel):
    results: list[BatchTriageItem]


# ── Single-thread pipeline stages ─────────────────────────────────────────────

class LoadThreadStage(Stage):
    """Loads the thread and all its messages from the database."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        session_factory = get_session_factory()
        async with session_factory() as session:
            stmt = select(EmailThread).where(EmailThread.id == ctx.thread_id)
            thread = (await session.execute(stmt)).scalar_one_or_none()
            if not thread:
                raise ValueError(f"Thread {ctx.thread_id} not found")

            msg_stmt = (
                select(EmailMessage)
                .where(EmailMessage.thread_id == ctx.thread_id)
                .order_by(EmailMessage.received_at.asc())
            )
            messages = (await session.execute(msg_stmt)).scalars().all()

            if not messages:
                raise ValueError(f"No messages found for thread {ctx.thread_id}")

            ctx.data["thread"] = thread
            ctx.data["messages"] = list(messages)
            ctx.data["latest_message"] = messages[-1]

        return ctx


class LLMTriageStage(Stage):
    """Uses LLM to classify a single email thread."""
    def __init__(self):
        self.llm_service = LLMService()

    async def process(self, ctx: PipelineContext) -> PipelineContext:
        categories_config = _load_categories()
        valid_ids = {c["id"] for c in categories_config["categories"]}
        default_fallback = categories_config["default_fallback"]

        system_prompt = _build_system_prompt(categories_config)
        messages = ctx.data["messages"]
        user_prompt_parts = []

        latest_msg = messages[-1] if messages else None
        if latest_msg and _is_noreply(latest_msg.from_address or ""):
            ctx.data["triage_result"] = {
                "classification": "info",
                "confidence": 1.0,
                "method": "heuristic",
                "reasoning": "Sender is a no-reply address",
                "llm_metadata": None
            }
            return ctx

        for i, msg in enumerate(messages):
            label = "Latest message" if i == len(messages) - 1 else f"Message {i + 1}"
            cc_flag = bool(msg.cc_addresses)
            bcc_flag = False
            if msg.raw_headers and isinstance(msg.raw_headers, dict):
                bcc_flag = 'bcc' in str(msg.raw_headers).lower()
            block = (
                f"[{label}]\n"
                f"From: {msg.from_address or 'Unknown'}\n"
                f"Subject: {msg.subject or '(no subject)'}\n"
                f"CC - Flag: {cc_flag}\n"
                f"BCC - Flag: {bcc_flag}\n"
            )
            user_prompt_parts.append(block)

        user_prompt = "\n\n---\n\n".join(user_prompt_parts)

        response_json_str, metrics = await self.llm_service.generate_structured(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_format=TriageResponse
        )

        ctx.usage.add(metrics["input_tokens"], metrics["output_tokens"], metrics["cost"])

        try:
            parsed = json.loads(response_json_str)
            classification = parsed.get("classification", default_fallback)
            confidence = parsed.get("confidence", 0.5)
            reasoning = parsed.get("reasoning", "")
            if classification not in valid_ids:
                logger.warning("triage.invalid_classification", returned=classification, fallback=default_fallback)
                classification = default_fallback
        except Exception as e:
            logger.error("triage.llm_parse_error", error=str(e))
            classification = default_fallback
            confidence = 0.0
            reasoning = f"Failed to parse LLM response: {str(e)}"

        ctx.data["triage_result"] = {
            "classification": classification,
            "confidence": confidence,
            "method": "llm",
            "reasoning": reasoning,
            "llm_metadata": metrics
        }
        return ctx


class SaveTriageResultStage(Stage):
    """Saves the triage classification to Postgres."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        if "triage_result" not in ctx.data:
            raise ValueError("No triage result was generated")

        res_data = ctx.data["triage_result"]
        session_factory = get_session_factory()
        async with session_factory() as session:
            stmt = pg_insert(TriageResult).values(
                thread_id=ctx.thread_id,
                classification=res_data["classification"],
                method=res_data["method"],
                confidence=res_data["confidence"],
                reasoning=res_data["reasoning"],
                llm_metadata=res_data.get("llm_metadata"),
            ).on_conflict_do_nothing(index_elements=["thread_id"])
            await session.execute(stmt)
            await session.commit()
        return ctx


# ── Batch pipeline stages ──────────────────────────────────────────────────────

class LoadBatchThreadsStage(Stage):
    """Loads metadata for all threads in the batch with a single DB query."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        thread_ids = ctx.data.get("thread_ids", [])
        if not thread_ids:
            ctx.should_stop = True
            return ctx

        # Parse to UUID for SQLAlchemy
        uuid_ids = [uuid.UUID(tid) if isinstance(tid, str) else tid for tid in thread_ids]

        session_factory = get_session_factory()
        async with session_factory() as session:
            threads_stmt = select(EmailThread).where(EmailThread.id.in_(uuid_ids))
            threads = (await session.execute(threads_stmt)).scalars().all()

            msgs_stmt = (
                select(EmailMessage)
                .where(EmailMessage.thread_id.in_(uuid_ids))
                .order_by(EmailMessage.received_at.asc())
            )
            all_messages = (await session.execute(msgs_stmt)).scalars().all()

        thread_msgs: dict[str, list] = defaultdict(list)
        for msg in all_messages:
            thread_msgs[str(msg.thread_id)].append(msg)

        thread_data: dict[str, dict] = {}
        for thread in threads:
            tid = str(thread.id)
            msgs = thread_msgs.get(tid, [])
            thread_data[tid] = {"thread": thread, "latest": msgs[-1] if msgs else None}

        ctx.data["batch_thread_data"] = thread_data
        return ctx


class BatchLLMTriageStage(Stage):
    """Classifies all threads in the batch with a single LLM call (after heuristic pre-filter)."""
    def __init__(self):
        self.llm_service = LLMService()

    async def process(self, ctx: PipelineContext) -> PipelineContext:
        if ctx.should_stop:
            return ctx

        categories_config = _load_categories()
        valid_ids = {c["id"] for c in categories_config["categories"]}
        default_fallback = categories_config["default_fallback"]

        batch_thread_data: dict[str, dict] = ctx.data.get("batch_thread_data", {})
        thread_ids = ctx.data.get("thread_ids", [])

        results: list[dict] = []
        llm_candidates: list[tuple[int, str]] = []  # (index_in_results, thread_id)

        # Apply heuristic pre-filter; queue non-trivial threads for LLM
        for tid in thread_ids:
            data = batch_thread_data.get(tid)
            if not data:
                results.append({"thread_id": tid, "classification": default_fallback,
                                 "confidence": 0.0, "method": "error",
                                 "reasoning": "Thread data not found", "llm_metadata": None})
                continue

            latest = data.get("latest")
            if latest and _is_noreply(latest.from_address or ""):
                results.append({"thread_id": tid, "classification": "info",
                                 "confidence": 1.0, "method": "heuristic",
                                 "reasoning": "Sender is a no-reply address", "llm_metadata": None})
            else:
                llm_candidates.append((len(results), tid))
                results.append(None)  # placeholder

        if not llm_candidates:
            ctx.data["batch_triage_results"] = results
            return ctx

        # Build numbered prompt for LLM candidates
        prompt_lines = []
        for seq_idx, (_, tid) in enumerate(llm_candidates):
            data = batch_thread_data[tid]
            latest = data.get("latest")
            from_addr = latest.from_address if latest else "Unknown"
            subject = latest.subject if latest else "(no subject)"
            cc_flag = bool(latest.cc_addresses) if latest else False
            prompt_lines.append(
                f"[{seq_idx}] From: {from_addr} | Subject: {subject} | CC: {'yes' if cc_flag else 'no'}"
            )

        user_prompt = "\n".join(prompt_lines)
        system_prompt = _build_batch_system_prompt(categories_config)

        # Estimate tokens: ~30 input tokens per thread + generous output budget
        estimated_max_tokens = max(1000, len(llm_candidates) * 80)

        try:
            response_json_str, metrics = await self.llm_service.generate_structured(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                response_format=BatchTriageResponse,
                max_tokens=estimated_max_tokens,
            )
            ctx.usage.add(metrics["input_tokens"], metrics["output_tokens"], metrics["cost"])

            parsed = json.loads(response_json_str)
            llm_results = parsed.get("results", [])

            # Map LLM results back to thread IDs
            llm_result_map: dict[int, dict] = {}
            for item in llm_results:
                seq_idx = item.get("thread_index")
                if seq_idx is not None and 0 <= seq_idx < len(llm_candidates):
                    classification = item.get("classification", default_fallback)
                    if classification not in valid_ids:
                        classification = default_fallback
                    llm_result_map[seq_idx] = {
                        "classification": classification,
                        "confidence": float(item.get("confidence", 0.5)),
                        "reasoning": item.get("reasoning", ""),
                        "llm_metadata": metrics,
                    }

            for seq_idx, (result_idx, tid) in enumerate(llm_candidates):
                llm_data = llm_result_map.get(seq_idx, {
                    "classification": default_fallback,
                    "confidence": 0.0,
                    "reasoning": "Missing from LLM response",
                    "llm_metadata": metrics,
                })
                results[result_idx] = {
                    "thread_id": tid,
                    "method": "llm",
                    **llm_data,
                }

        except Exception as e:
            logger.error("triage.batch.llm_failed", error=str(e))
            for seq_idx, (result_idx, tid) in enumerate(llm_candidates):
                results[result_idx] = {
                    "thread_id": tid,
                    "classification": default_fallback,
                    "confidence": 0.0,
                    "method": "llm_error",
                    "reasoning": f"LLM call failed: {str(e)}",
                    "llm_metadata": None,
                }

        ctx.data["batch_triage_results"] = [r for r in results if r is not None]
        return ctx


class SaveBatchTriageResultsStage(Stage):
    """Bulk-inserts all batch triage results with ON CONFLICT DO NOTHING for idempotency."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        if ctx.should_stop:
            return ctx

        results = ctx.data.get("batch_triage_results", [])
        if not results:
            return ctx

        session_factory = get_session_factory()
        async with session_factory() as session:
            for res in results:
                stmt = pg_insert(TriageResult).values(
                    thread_id=res["thread_id"],
                    classification=res["classification"],
                    method=res["method"],
                    confidence=res["confidence"],
                    reasoning=res.get("reasoning"),
                    llm_metadata=res.get("llm_metadata"),
                ).on_conflict_do_nothing(index_elements=["thread_id"])
                await session.execute(stmt)
            await session.commit()

        logger.info("triage.batch.saved", count=len(results))
        return ctx


# ── Pipeline factories ─────────────────────────────────────────────────────────

def create_triage_pipeline() -> Pipeline:
    """Single-thread triage pipeline."""
    return Pipeline("triage_workflow", [
        LoadThreadStage(),
        LLMTriageStage(),
        SaveTriageResultStage(),
    ])

def create_batch_triage_pipeline() -> Pipeline:
    """Batch triage pipeline — classifies N threads in a single LLM call."""
    return Pipeline("batch_triage_workflow", [
        LoadBatchThreadsStage(),
        BatchLLMTriageStage(),
        SaveBatchTriageResultsStage(),
    ])
