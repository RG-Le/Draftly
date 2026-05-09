"""Pipeline framework — composable workflow stages.

This is the core abstraction for all AI workflows (triage, draft, profile, future).
Each workflow is a Pipeline composed of Stages that process a shared PipelineContext.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
import time
import structlog

logger = structlog.get_logger()


@dataclass
class UsageAccumulator:
    """Tracks token usage and cost across pipeline stages."""

    input_tokens: int = 0
    output_tokens: int = 0
    total_cost: float = 0.0
    llm_calls: int = 0

    def add(self, input_tokens: int, output_tokens: int, cost: float) -> None:
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.total_cost += float(cost)  # Ensure float even if Decimal slips through
        self.llm_calls += 1

    def to_dict(self) -> dict:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_cost": self.total_cost,
            "llm_calls": self.llm_calls,
        }


@dataclass
class PipelineContext:
    """Carries data through pipeline stages.

    Every field is explicitly typed. Stages read from and write to `data` dict.
    """

    correlation_id: str
    user_id: str
    thread_id: str
    data: dict = field(default_factory=dict)
    should_stop: bool = False
    errors: list[str] = field(default_factory=list)
    usage: UsageAccumulator = field(default_factory=UsageAccumulator)


class Stage(ABC):
    """Single-responsibility processing step in a pipeline."""

    @property
    def name(self) -> str:
        return self.__class__.__name__

    @abstractmethod
    async def process(self, ctx: PipelineContext) -> PipelineContext:
        """Process context and return (possibly modified) context.

        If a stage sets ctx.should_stop = True, the pipeline will stop
        executing further stages.
        """
        ...


class Pipeline:
    """Ordered sequence of stages. Executes stages sequentially.

    Handles per-stage timing, error isolation, and logging.
    """

    def __init__(self, name: str, stages: list[Stage]):
        self.name = name
        self.stages = stages

    async def execute(self, ctx: PipelineContext) -> PipelineContext:
        log = logger.bind(
            pipeline=self.name,
            correlation_id=ctx.correlation_id,
            user_id=ctx.user_id,
            thread_id=ctx.thread_id,
        )
        log.info("pipeline.started", stage_count=len(self.stages))

        for stage in self.stages:
            stage_start = time.monotonic()
            try:
                ctx = await stage.process(ctx)
                duration_ms = round((time.monotonic() - stage_start) * 1000, 1)
                log.info(
                    "pipeline.stage.completed",
                    stage=stage.name,
                    duration_ms=duration_ms,
                    should_stop=ctx.should_stop,
                )
            except Exception as e:
                duration_ms = round((time.monotonic() - stage_start) * 1000, 1)
                ctx.errors.append(f"{stage.name}: {str(e)}")
                log.error(
                    "pipeline.stage.failed",
                    stage=stage.name,
                    duration_ms=duration_ms,
                    error=str(e),
                )
                ctx.should_stop = True

            if ctx.should_stop:
                log.info("pipeline.stopped_early", last_stage=stage.name)
                break

        log.info(
            "pipeline.completed",
            total_errors=len(ctx.errors),
            llm_calls=ctx.usage.llm_calls,
            total_tokens=ctx.usage.input_tokens + ctx.usage.output_tokens,
        )
        return ctx
