import structlog
import uuid
import json
from sqlalchemy import select
from jinja2 import Template

from src.pipelines.base import Pipeline, Stage, PipelineContext
from src.infrastructure.database.models import EmailThread, EmailMessage, Draft, UserProfile, User
from src.config.database import get_session_factory
from src.infrastructure.llm.llm_service import LLMService
from src.infrastructure.llm.prompt_manager import PromptManager

logger = structlog.get_logger()

class LoadThreadHistoryStage(Stage):
    """Loads the entire thread history for context."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        session_factory = get_session_factory()
        async with session_factory() as session:
            stmt = select(EmailMessage).where(EmailMessage.thread_id == ctx.thread_id).order_by(EmailMessage.received_at.asc())
            result = await session.execute(stmt)
            messages = result.scalars().all()
            
            if not messages:
                raise ValueError(f"No messages found for thread {ctx.thread_id}")
                
            ctx.data['messages'] = list(messages)

            # Load user's email address for context labeling
            user_stmt = select(User.email).where(User.id == ctx.user_id)
            user_result = await session.execute(user_stmt)
            user_email = user_result.scalar_one_or_none()
            ctx.data['user_email'] = user_email

        return ctx

class LoadUserProfileStage(Stage):
    """Loads the user's personalized communication profile to inform draft generation."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        session_factory = get_session_factory()
        async with session_factory() as session:
            stmt = select(UserProfile).where(UserProfile.user_id == ctx.user_id)
            result = await session.execute(stmt)
            profile = result.scalar_one_or_none()
            
            ctx.data['user_profile'] = profile
            
        return ctx

class FormatContextStage(Stage):
    """Formats messages and user profile into a readable context for the LLM."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        messages = ctx.data['messages']
        user_email = ctx.data.get('user_email')
        
        # Build chronological message history
        context_blocks = []
        reply_to_sender = None
        for msg in messages:
            sender = msg.from_address or 'Unknown'
            date = msg.received_at.strftime("%Y-%m-%d %H:%M") if msg.received_at else "Unknown Date"
            body = msg.body_text or "[Blank Email]"
            
            if msg.is_sent_by_user:
                context_blocks.append(f"--- On {date}, [YOU replied] ---\n{body}")
            else:
                context_blocks.append(f"--- On {date}, {sender} wrote ---\n{body}")
                # Track the last incoming message (not from user)
                reply_to_sender = sender
            
        ctx.data['thread_context'] = "\n\n".join(context_blocks)
        ctx.data['reply_to_sender'] = reply_to_sender or "Unknown"
        
        # truncate extremely long threads
        if len(ctx.data['thread_context']) > 6000:
            ctx.data['thread_context'] = "..." + ctx.data['thread_context'][-6000:]
        
        # Build persona context from user profile
        profile = ctx.data.get('user_profile')
        if profile:
            persona_parts = []
            if profile.preferred_tone:
                persona_parts.append(f"Preferred tone: {profile.preferred_tone}")
            if profile.greeting_style:
                greet = json.dumps(profile.greeting_style) if isinstance(profile.greeting_style, dict) else str(profile.greeting_style)
                persona_parts.append(f"Greeting style: {greet}")
            if profile.closing_style:
                close = json.dumps(profile.closing_style) if isinstance(profile.closing_style, dict) else str(profile.closing_style)
                persona_parts.append(f"Closing style: {close}")
            if profile.communication_norms:
                norms = json.dumps(profile.communication_norms) if isinstance(profile.communication_norms, dict) else str(profile.communication_norms)
                persona_parts.append(f"Communication norms: {norms}")
            if profile.personalized_profile:
                persona_parts.append(f"Writing style instructions: {profile.personalized_profile}")
            if profile.signature_template:
                persona_parts.append(f"Signature: {profile.signature_template}")
            persona_parts.append(f"Reply to: {ctx.data['reply_to_sender']}")
            ctx.data['persona_context'] = "\n".join(persona_parts)
        else:
            ctx.data['persona_context'] = f"No user profile available. Use a professional, concise tone.\nReply to: {ctx.data['reply_to_sender']}"
            
        return ctx

class LLMDraftGenerationStage(Stage):
    """Generates the actual email response using LiteLLM, informed by user persona."""
    def __init__(self):
        self.llm_service = LLMService()
        self.prompt_manager = PromptManager()
        
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        # Fetch templates
        templates = await self.prompt_manager.get_template("draft_v1")
        
        system_prompt = templates["system_prompt"]
        user_template = Template(templates["user_prompt_template"])
        
        user_prompt = user_template.render(
            thread_context=ctx.data['thread_context'],
            persona_context=ctx.data.get('persona_context', ''),
            reply_to_sender=ctx.data.get('reply_to_sender', 'Unknown'),
            user_email=ctx.data.get('user_email', 'the user')
        )
        
        # Generate Draft
        content, metrics = await self.llm_service.generate(system_prompt, user_prompt)
        
        ctx.usage.add(metrics['input_tokens'], metrics['output_tokens'], metrics['cost'])
        
        # Check if LLM indicates no reply is needed
        if "[NO_REPLY_NEEDED]" in content:
            ctx.data["draft_content"] = None
            ctx.data["no_reply_needed"] = True
            ctx.should_stop = True
            return ctx
        
        ctx.data['draft_content'] = content
        ctx.data['llm_metadata'] = metrics
        
        return ctx

class SaveDraftStage(Stage):
    """Persists the auto-generated draft to the DB. Upserts — updates existing draft if present."""
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        if "draft_content" not in ctx.data:
            raise ValueError("Draft generation failed, no content")

        session_factory = get_session_factory()
        async with session_factory() as session:
            # Check for an existing draft on this thread
            # Use .first() instead of .scalar_one_or_none() to handle existing duplicates gracefully
            existing_stmt = select(Draft).where(Draft.thread_id == ctx.thread_id).order_by(Draft.created_at.desc())
            existing = (await session.execute(existing_stmt)).scalars().first()

            if existing:
                # Update existing draft in place — no versioning
                existing.generated_content = ctx.data["draft_content"]
                existing.current_content = ctx.data["draft_content"]
                existing.status = "generated"
                existing.generation_metadata = ctx.data.get("llm_metadata")
                await session.commit()
                ctx.data["draft_id"] = str(existing.id)
                logger.info("draft.updated_existing", thread_id=ctx.thread_id, draft_id=str(existing.id))
            else:
                # Create new draft
                draft = Draft(
                    thread_id=ctx.thread_id,
                    user_id=ctx.user_id,
                    generated_content=ctx.data["draft_content"],
                    current_content=ctx.data["draft_content"],
                    status="generated",
                    version=1,
                    generation_metadata=ctx.data.get("llm_metadata"),
                    idempotency_key=f"ai_gen_{ctx.thread_id}_{uuid.uuid4().hex[:8]}"
                )
                session.add(draft)
                await session.commit()
                ctx.data["draft_id"] = str(draft.id)
                logger.info("draft.created_new", thread_id=ctx.thread_id, draft_id=str(draft.id))

        return ctx

def create_draft_pipeline() -> Pipeline:
    """Builds and returns the Draft generation pipeline."""
    return Pipeline("draft_workflow", [
        LoadThreadHistoryStage(),
        LoadUserProfileStage(),
        FormatContextStage(),
        LLMDraftGenerationStage(),
        SaveDraftStage()
    ])
