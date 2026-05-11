"""Draftly AI Engine — Configuration from environment variables."""

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """All configuration from environment. Validated at startup."""

    # Database (direct PG, not PgBouncer — Celery workers need persistent connections)
    db_host: str = Field(default="postgres", alias="DB_HOST")
    db_port: int = Field(default=5432)
    db_name: str = Field(default="draftly", alias="DB_NAME")
    db_user: str = Field(default="draftly", alias="DB_USER")
    db_password: str = Field(alias="DB_PASSWORD")

    # Redis
    redis_url: str = Field(default="redis://redis:6379", alias="REDIS_URL")

    # LLM
    gemini_api_key: str | None = Field(default=None, alias="GEMINI_API_KEY")
    openrouter_api_key: str | None = Field(default=None, alias="OPENROUTER_API_KEY")
    openai_api_key: str | None = Field(default=None, alias="OPENAI_API_KEY")
    openai_base_url: str | None = Field(default=None, alias="OPENAI_BASE_URL")
    llm_primary_model: str = Field(default="gemini/gemini-2.0-flash", alias="LLM_PRIMARY_MODEL")
    llm_fallback_model: str = Field(default="gemini/gemini-1.5-flash", alias="LLM_FALLBACK_MODEL")

    # Budget
    llm_budget_hourly_tokens: int = Field(default=50000, alias="LLM_BUDGET_HOURLY_TOKENS")
    llm_budget_daily_tokens: int = Field(default=200000, alias="LLM_BUDGET_DAILY_TOKENS")

    # Triage
    triage_batch_size: int = Field(default=25, alias="TRIAGE_BATCH_SIZE")

    @property
    def database_url(self) -> str:
        return f"postgresql+asyncpg://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"

    @property
    def database_url_sync(self) -> str:
        return f"postgresql://{self.db_user}:{self.db_password}@{self.db_host}:{self.db_port}/{self.db_name}"

    model_config = {
        "env_file": [".env", "../.env"],
        "case_sensitive": False,
        "extra": "ignore"
    }


# Singleton
_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()  # type: ignore
    return _settings
