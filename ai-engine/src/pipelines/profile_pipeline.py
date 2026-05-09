import structlog
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert
import json

from src.pipelines.base import Pipeline, Stage, PipelineContext
from src.infrastructure.database.models import EmailMessage, UserProfile
from src.config.database import get_session_factory
from src.infrastructure.llm.llm_service import LLMService

logger = structlog.get_logger()

class ProfileResponse(BaseModel):
    greeting_style: Dict[str, Any]
    closing_style: Dict[str, Any]
    preferred_tone: str
    communication_norms: Dict[str, Any]
    confidence_score: float

class LoadSentEmailsStage(Stage):
    """Loads the last N emails sent by the user for style analysis."""
    def __init__(self, limit=20):
        self.limit = limit

    async def process(self, ctx: PipelineContext) -> PipelineContext:
        session_factory = get_session_factory()
        async with session_factory() as session:
            # Join path: user_connections(user_id) → email_threads(connection_id) → email_messages(thread_id)
            from src.infrastructure.database.models import EmailThread, UserConnection
            stmt = (
                select(EmailMessage)
                .join(EmailThread, EmailMessage.thread_id == EmailThread.id)
                .join(UserConnection, EmailThread.connection_id == UserConnection.id)
                .where(UserConnection.user_id == ctx.user_id)
                .where(EmailMessage.is_sent_by_user == True)
                .order_by(EmailMessage.received_at.desc())
                .limit(self.limit)
            )
            result = await session.execute(stmt)
            messages = result.scalars().all()
            
            if not messages:
                logger.info("profile.no_sent_emails_found", user_id=str(ctx.user_id))
                ctx.data['is_cold_start'] = True
                ctx.data['sent_messages'] = []
            else:
                ctx.data['is_cold_start'] = False
                ctx.data['sent_messages'] = list(messages)
            
        return ctx

class FormatSentEmailsStage(Stage):
    """Formats sent messages into an analysis payload."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        if ctx.should_stop or ctx.data.get('is_cold_start'):
            return ctx
            
        messages = ctx.data['sent_messages']
        
        email_blocks = []
        for msg in messages:
            body = msg.body_text or ""
            # Only analyze emails that have actual text
            if len(body.split()) > 5:
                email_blocks.append(f"Subject: {msg.subject}\nBody:\n{body}")
                
        ctx.data['analysis_text'] = "\n\n---\n\n".join(email_blocks)
        
        if not ctx.data['analysis_text']:
            logger.info("profile.no_valid_text", user_id=str(ctx.user_id))
            ctx.data['is_cold_start'] = True
            
        return ctx

class LLMProfileGenerationStage(Stage):
    """Generates the user's communication profile using LiteLLM."""
    def __init__(self):
        self.llm_service = LLMService()
        
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        if ctx.should_stop:
            return ctx

        if ctx.data.get('is_cold_start'):
            # Provide a high-quality professional default for new users
            logger.info("profile.applying_default_bootstrap", user_id=str(ctx.user_id))
            ctx.data['profile'] = {
                "greeting_style": {"formal": True, "common_phrases": ["Hello", "Hi"]},
                "closing_style": {"formal": True, "common_phrases": ["Best regards", "Thanks"]},
                "preferred_tone": "professional, concise, and helpful",
                "communication_norms": {"uses_bullet_points": False, "sentence_length": "medium"},
                "confidence_score": 0.5
            }
            return ctx
            
        system_prompt = (
            "You are an expert communications analyst. Analyze the following emails written by a single user. "
            "Extract their core writing style. Return a structured JSON containing:\n"
            "- greeting_style: e.g. {'formal': False, 'common_phrases': ['Hi team', 'Hey']}\n"
            "- closing_style: e.g. {'formal': True, 'common_phrases': ['Best,', 'Thanks,']}\n"
            "- preferred_tone: A string summarizing their tone (e.g., 'direct, concise, friendly')\n"
            "- communication_norms: Any recurring patterns (e.g., {'uses_bullet_points': True, 'sentence_length': 'short'})\n"
            "- confidence_score: Float between 0.0 and 1.0 representing how confident you are in this analysis."
        )
        
        user_prompt = f"Analyze these sent emails:\n\n{ctx.data['analysis_text'][:15000]}"
        
        response_json_str, metrics = await self.llm_service.generate_structured(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_format=ProfileResponse
        )
        
        ctx.usage.add(metrics['input_tokens'], metrics['output_tokens'], metrics['cost'])
        
        try:
            parsed = json.loads(response_json_str)
            ctx.data['profile'] = parsed
        except Exception as e:
            logger.error("profile.llm_parse_error", error=str(e), response=response_json_str)
            ctx.should_stop = True
            
        return ctx

class SaveProfileStage(Stage):
    """Upserts the profile to the database."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        if ctx.should_stop or 'profile' not in ctx.data:
            return ctx
            
        profile = ctx.data['profile']
        
        session_factory = get_session_factory()
        async with session_factory() as session:
            stmt = insert(UserProfile).values(
                user_id=ctx.user_id,
                greeting_style=profile.get('greeting_style'),
                closing_style=profile.get('closing_style'),
                preferred_tone=profile.get('preferred_tone'),
                communication_norms=profile.get('communication_norms'),
                confidence_score=profile.get('confidence_score', 0.0),
                profile_version=1
            ).on_conflict_do_update(
                index_elements=['user_id'],
                set_={
                    'greeting_style': profile.get('greeting_style'),
                    'closing_style': profile.get('closing_style'),
                    'preferred_tone': profile.get('preferred_tone'),
                    'communication_norms': profile.get('communication_norms'),
                    'confidence_score': profile.get('confidence_score', 0.0),
                    'profile_version': UserProfile.profile_version + 1,
                    'updated_at': func.now()
                }
            )
            
            await session.execute(stmt)
            await session.commit()
            
        return ctx

def create_profile_pipeline() -> Pipeline:
    """Builds and returns the Profile analysis pipeline."""
    return Pipeline("profile_workflow", [
        LoadSentEmailsStage(limit=20),
        FormatSentEmailsStage(),
        LLMProfileGenerationStage(),
        SaveProfileStage()
    ])
