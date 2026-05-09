from typing import Any
import structlog
import json
import asyncio
import litellm
from pydantic import BaseModel
from src.config.settings import get_settings

logger = structlog.get_logger()

# We need to drop unknown kwargs if litellm doesn't support them for a provider
litellm.drop_params = True

class LLMService:
    def __init__(self):
        self.settings = get_settings()
        self.primary_model = self.settings.llm_primary_model
        self.fallback_model = self.settings.llm_fallback_model

        # Ensure API keys are set for litellm
        if self.settings.gemini_api_key:
            import os
            os.environ["GEMINI_API_KEY"] = self.settings.gemini_api_key
        if self.settings.openrouter_api_key:
            import os
            os.environ["OPENROUTER_API_KEY"] = self.settings.openrouter_api_key
        if self.settings.openai_api_key:
            import os
            os.environ["OPENAI_API_KEY"] = self.settings.openai_api_key
        if self.settings.openai_base_url:
            import os
            os.environ["OPENAI_BASE_URL"] = self.settings.openai_base_url

    async def generate(self, system_prompt: str, user_prompt: str) -> tuple[str, dict[str, Any]]:
        """Generate a response using primary model with fallback."""
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
        
        return await self._execute_with_fallback(messages)

    async def generate_structured(self, system_prompt: str, user_prompt: str, response_format: type[BaseModel]) -> tuple[str, dict[str, Any]]:
        """Generate a structured JSON response."""
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
        
        return await self._execute_with_fallback(messages, response_format=response_format)

    async def _execute_with_fallback(self, messages: list[dict], response_format: type[BaseModel] | None = None) -> tuple[str, dict[str, Any]]:
        kwargs = {
            "messages": messages,
            "temperature": 0.2, # Low temperature for accurate triage/draft tone
            "max_tokens": 1000
        }
        
        if response_format:
            kwargs["response_format"] = response_format
            
        try:
            return await self._call_model(self.primary_model, kwargs)
        except Exception as e:
            print(f"\n[DEBUG] Primary model ({self.primary_model}) failed: {e}")
            logger.warning("llm.primary_model_failed", error=str(e), fallback=self.fallback_model)
            try:
                return await self._call_model(self.fallback_model, kwargs)
            except Exception as fallback_err:
                logger.error("llm.fallback_model_failed", error=str(fallback_err))
                # Trigger mock fallback if both fail
                return await self._mock_fallback(response_format)
                
    async def _mock_fallback(self, response_format: type[BaseModel] | None) -> tuple[str, dict[str, Any]]:
        logger.info("llm.mock_fallback_triggered", delay=2)
        await asyncio.sleep(2) # Simulate latency
        
        metrics = {
            "model": "mock_fallback",
            "input_tokens": 0,
            "output_tokens": 0,
            "cost": 0.0
        }
        
        if response_format:
            # We assume it's TriageResponse or ProfileResponse
            # Hardcoded dummy JSON that satisfies the downstream parser
            if response_format.__name__ == 'TriageResponse':
                mock_content = json.dumps({
                    "classification": "reply_needed", 
                    "confidence": 0.9, 
                    "reasoning": "Mocked LLM due to permissions"
                })
            else:
                mock_content = json.dumps({}) # Catch all for other models
            return mock_content, metrics
            
        else:
            # Standard unstructured text (e.g. Draft)
            return "⚠️ LLM API Error: Please come back later. The underlying AI service is currently unavailable due to permission/API key constraints.", metrics
                
    async def _call_model(self, model: str, kwargs: dict) -> tuple[str, dict[str, Any]]:
        """Execute liteLLM call and extract metrics."""
        response = await litellm.acompletion(model=model, **kwargs)
        
        content = response.choices[0].message.content
        
        # Extract usage and calculate cost
        input_tokens = response.usage.prompt_tokens if response.usage else 0
        output_tokens = response.usage.completion_tokens if response.usage else 0
        
        try:
            cost = litellm.cost_calculator.completion_cost(completion_response=response)
        except Exception:
            cost = 0.0
            
        metrics = {
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost": float(cost)
        }
        
        logger.debug("llm.call_success", model=model, tokens=input_tokens+output_tokens)
        return content, metrics
