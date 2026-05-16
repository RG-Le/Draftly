import json
import structlog
from src.infrastructure.redis.connection import get_redis
from src.config.database import get_session_factory
from src.infrastructure.database.models import PromptTemplate
from sqlalchemy import select

logger = structlog.get_logger()

# Hardcoded fallback templates in case DB is empty or down
_FALLBACK_PROMPTS = {
    "triage_v1": {
        # Note: this fallback is only used if DB+Redis are unavailable.
        # The live triage pipeline builds this prompt dynamically from triage_categories.json.
        "system_prompt": """You are an AI assistant designed to triage emails.
Classify the given email into exactly one of the following categories:
- reply_needed: The email expects a response or action from the user (e.g., questions, meeting requests, action items).
- promotions: Marketing emails, deals, newsletters, or broadcast content from companies or services.
- info: Informational notifications, receipts, shipping updates, automated alerts — no response needed.

If uncertain, default to 'info'.

Respond strictly with JSON:
{"classification": "<category_id>", "confidence": <0.0-1.0>, "reasoning": "<short explanation>"}""",
        "user_prompt_template": "From: {{ sender }}\nTo: {{ to }}\n{% if cc %}CC: {{ cc }}\n{% endif %}Subject: {{ subject }}\n\nBody:\n{{ body_plain }}"
    },
    "draft_v1": {
        "system_prompt": """You are a highly capable executive assistant drafting email replies on behalf of the user. 
Analyze the thread, understand the context, and generate a polite, concise, and professional reply.
Keep the tone helpful. If you lack information, provide a plausible placeholder e.g., [insert time].

CRITICAL RULES:
1. You are writing AS the user (the person who owns this inbox). Messages marked [YOU replied] are the user's previous messages.
2. NEVER address the reply to the user themselves. The reply goes TO the sender of the last incoming message.
3. Only draft a reply to the most recent INCOMING message (from someone else, not marked [YOU replied]).
4. The greeting should address the SENDER of the last incoming message, NOT the user.
5. If no incoming message needs a reply, respond with exactly: [NO_REPLY_NEEDED]""",
        "user_prompt_template": "You are writing on behalf of: {{ user_email }}\n\nThread Context:\n{{ thread_context }}\n\nUser's writing style:\n{{ persona_context }}\n\nDraft a reply FROM {{ user_email }} TO {{ reply_to_sender }}.\nThe greeting should address {{ reply_to_sender }}, NOT {{ user_email }}.\nDo NOT start with 'Hello {{ user_email }}' — that would be addressing yourself."
    }
}

class PromptManager:
    """Manages prompt template resolution across Redis, Postgres, and code fallbacks."""

    def __init__(self):
        self.redis = get_redis()
        self.session_factory = get_session_factory()
        self.cache_ttl = 300  # 5 minutes

    async def get_template(self, name: str) -> dict[str, str]:
        """Fetch a prompt template by name."""
        cache_key = f"prompt_template:{name}"

        # 1. Try Redis Cache
        try:
            cached = await self.redis.get(cache_key)
            if cached:
                logger.debug("prompt.cache_hit", name=name)
                return json.loads(cached)
        except Exception as e:
            logger.warning("prompt.redis_error", error=str(e))

        # 2. Try Postgres DB
        try:
            async with self.session_factory() as session:
                stmt = select(PromptTemplate).where(PromptTemplate.name == name, PromptTemplate.is_active == True)
                result = await session.execute(stmt)
                template = result.scalar_one_or_none()

            if template:
                data = {
                    "system_prompt": template.system_prompt,
                    "user_prompt_template": template.user_prompt_template
                }
                
                # Update Cache asynchronously (fire and forget handled by await here since it's fast)
                try:
                    await self.redis.setex(cache_key, self.cache_ttl, json.dumps(data))
                except Exception as e:
                    logger.warning("prompt.redis_set_error", error=str(e))

                logger.info("prompt.db_hit", name=name)
                return data
        except Exception as e:
            logger.error("prompt.db_error", error=str(e))

        # 3. Code Fallback
        logger.warning("prompt.fallback_used", name=name)
        fallback = _FALLBACK_PROMPTS.get(name)
        if not fallback:
            raise ValueError(f"No prompt template found for '{name}' and no fallback exists.")
            
        return fallback

    async def invalidate_cache(self, name: str):
        """Force clear a prompt from the cache."""
        await self.redis.delete(f"prompt_template:{name}")
