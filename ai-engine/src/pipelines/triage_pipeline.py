import json
import structlog
from pathlib import Path
from typing import Any
from pydantic import BaseModel
from sqlalchemy import select

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

# Structured output schema for LLM
class TriageResponse(BaseModel):
    classification: str
    confidence: float
    reasoning: str


# ── Stage 1: Load thread + all messages ───────────────────────────────────────
class LoadThreadStage(Stage):
    """Loads the thread and all its messages from the database."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        session_factory = get_session_factory()
        async with session_factory() as session:
            stmt = select(EmailThread).where(EmailThread.id == ctx.thread_id)
            thread = (await session.execute(stmt)).scalar_one_or_none()
            if not thread:
                raise ValueError(f"Thread {ctx.thread_id} not found")

            # Get all messages, ordered oldest first
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


# ── Stage 2: Full LLM Triage (no heuristics) ─────────────────────────────────
class LLMTriageStage(Stage):
    """Uses LLM to classify the email. Passes full email context: From, To, CC, Subject, Body."""
    def __init__(self):
        self.llm_service = LLMService()

    async def process(self, ctx: PipelineContext) -> PipelineContext:
        categories_config = _load_categories()
        valid_ids = {c["id"] for c in categories_config["categories"]}
        default_fallback = categories_config["default_fallback"]

        system_prompt = _build_system_prompt(categories_config)

        # Build rich user prompt with limited email context (no body)
        messages = ctx.data["messages"]
        user_prompt_parts = []
        
        # Pre-filter for no-reply
        latest_msg = messages[-1] if messages else None
        if latest_msg:
            from_addr = latest_msg.from_address or ""
            from_lower = from_addr.lower()
            if "no-reply" in from_lower or "noreply" in from_lower or "do-not-reply" in from_lower:
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
            from_addr = msg.from_address or "Unknown"
            
            # Extract raw headers if we need to check explicitly, but we'll use flags
            cc_flag = bool(msg.cc_addresses)
            # BCC is typically not available in incoming messages unless we check raw headers or it's the sent message
            bcc_flag = False 
            if msg.raw_headers and isinstance(msg.raw_headers, dict):
                # raw_headers is typically a list of dicts or a dict, depending on the parser
                # we'll just check if 'Bcc' is in the string representation
                bcc_flag = 'bcc' in str(msg.raw_headers).lower()

            subject = msg.subject or "(no subject)"

            block = (
                f"[{label}]\n"
                f"From: {from_addr}\n"
                f"Subject: {subject}\n"
                f"CC - Flag: {cc_flag}\n"
                f"BCC - Flag: {bcc_flag}\n"
            )
            user_prompt_parts.append(block)

        user_prompt = "\n\n---\n\n".join(user_prompt_parts)

        # Call LLM
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

            # Enforce valid category — fall back to default if LLM hallucinates
            if classification not in valid_ids:
                logger.warning(
                    "triage.invalid_classification",
                    returned=classification,
                    valid=list(valid_ids),
                    fallback=default_fallback,
                )
                classification = default_fallback

        except Exception as e:
            logger.error("triage.llm_parse_error", error=str(e), response=response_json_str)
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


# ── Stage 3: Persist triage result ────────────────────────────────────────────
class SaveTriageResultStage(Stage):
    """Saves the triage classification to Postgres."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        if "triage_result" not in ctx.data:
            raise ValueError("No triage result was generated")

        res_data = ctx.data["triage_result"]

        session_factory = get_session_factory()
        async with session_factory() as session:
            triage = TriageResult(
                thread_id=ctx.thread_id,
                classification=res_data["classification"],
                method=res_data["method"],
                confidence=res_data["confidence"],
                reasoning=res_data["reasoning"],
                llm_metadata=res_data.get("llm_metadata"),
            )
            session.add(triage)
            await session.commit()

        return ctx


def create_triage_pipeline() -> Pipeline:
    """Builds and returns the configured Triage pipeline."""
    return Pipeline("triage_workflow", [
        LoadThreadStage(),
        LLMTriageStage(),
        SaveTriageResultStage(),
    ])
