from sqlalchemy import Column, String, Text, Boolean, Integer, Numeric, DateTime, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import declarative_base, relationship
from datetime import datetime, timezone
import uuid

Base = declarative_base()

class User(Base):
    __tablename__ = 'users'
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), nullable=False, unique=True)
    name = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False, default='user')
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class UserProfile(Base):
    __tablename__ = 'user_profiles'
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False, unique=True)
    greeting_style = Column(JSON)
    closing_style = Column(JSON)
    signature_template = Column(Text)
    personalized_profile = Column(Text)
    preferred_tone = Column(String(50))
    communication_norms = Column(JSON)
    current_priorities = Column(JSON)
    profile_version = Column(Integer, default=1, nullable=False)
    confidence_score = Column(Numeric(3, 2), default=0.0)
    profile_source = Column(String(20), nullable=False, default='default')
    last_calibrated_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class UserConnection(Base):
    __tablename__ = 'user_connections'
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    connector_type = Column(String(50), nullable=False)
    status = Column(String(20), nullable=False, default='active')
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class EmailThread(Base):
    __tablename__ = 'email_threads'
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    connection_id = Column(UUID(as_uuid=True), nullable=False)
    external_thread_id = Column(String(255), nullable=False)
    subject = Column(String(500))
    participants = Column(JSON)
    message_count = Column(Integer, default=0)
    last_message_at = Column(DateTime(timezone=True))
    sync_status = Column(String(50), default='pending')
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    messages = relationship("EmailMessage", back_populates="thread")
    triage_result = relationship("TriageResult", back_populates="thread", uselist=False)
    drafts = relationship("Draft", back_populates="thread")

class EmailMessage(Base):
    __tablename__ = 'email_messages'
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    thread_id = Column(UUID(as_uuid=True), ForeignKey('email_threads.id', ondelete='CASCADE'), nullable=False)
    external_message_id = Column(String(255), nullable=False, unique=True)
    from_address = Column(String(255), nullable=False)
    to_addresses = Column(JSON, nullable=False)
    cc_addresses = Column(JSON)
    subject = Column(String(500))
    body_text = Column(Text)
    body_html = Column(Text)
    raw_headers = Column(JSON)
    received_at = Column(DateTime(timezone=True))
    is_sent_by_user = Column(Boolean, nullable=False, default=False)
    is_draft = Column(Boolean, nullable=False, server_default='false')
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    
    thread = relationship("EmailThread", back_populates="messages")

class TriageResult(Base):
    __tablename__ = 'triage_results'
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    thread_id = Column(UUID(as_uuid=True), ForeignKey('email_threads.id', ondelete='CASCADE'), nullable=False, unique=True)
    classification = Column(String(50), nullable=False)
    method = Column(String(20), nullable=False)
    confidence = Column(Numeric(3, 2))
    reasoning = Column(Text)
    llm_metadata = Column(JSON)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    thread = relationship("EmailThread", back_populates="triage_result")

class Draft(Base):
    __tablename__ = 'drafts'
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    thread_id = Column(UUID(as_uuid=True), ForeignKey('email_threads.id', ondelete='CASCADE'), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    generated_content = Column(Text)
    current_content = Column(Text)
    status = Column(String(20), nullable=False)
    version = Column(Integer, default=1, nullable=False)
    generation_metadata = Column(JSON)
    idempotency_key = Column(String(255), unique=True)
    external_draft_id = Column(String(255), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    thread = relationship("EmailThread", back_populates="drafts")

class PromptTemplate(Base):
    __tablename__ = 'prompt_templates'
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False, unique=True)
    description = Column(Text)
    system_prompt = Column(Text, nullable=False)
    user_prompt_template = Column(Text, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
