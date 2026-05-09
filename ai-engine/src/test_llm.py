import sys
import io

# Ensure UTF-8 output on Windows console
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

import asyncio
import os
from pathlib import Path

# Add the project root to sys.path to allow imports
sys.path.append(str(Path(__file__).parent.parent))

from src.infrastructure.llm.llm_service import LLMService
from src.config.settings import get_settings

async def test_llm():
    print("--- LLM Connectivity Test ---")
    settings = get_settings()
    
    # Manually check if keys are loaded in environment
    print(f"Primary Model: {settings.llm_primary_model}")
    print(f"Gemini API Key: {'Set' if settings.gemini_api_key else 'Not Set'}")
    print(f"OpenRouter API Key: {'Set' if settings.openrouter_api_key else 'Not Set'}")
    
    service = LLMService()
    
    print("\nTesting 'Hi' prompt...")
    try:
        # We use a direct call to test the actual API (not the mock)
        # To do this, we temporarily disable the mock fallback or just check the result
        content, metrics = await service.generate("You are a helpful assistant.", "Hi")
        
        print("\n[SUCCESS] LLM Response:")
        print(f"Content: {content}")
        print(f"Metrics: {metrics}")
        
        if metrics.get("model") == "mock_fallback":
            print("\n[WARNING] The system fell back to MOCK mode. This means the actual API call failed (check logs for 'llm.primary_model_failed').")
        else:
            print("\n[VERIFIED] Actual API call succeeded!")
            
    except Exception as e:
        print(f"\n[ERROR] Test failed with exception: {e}")

if __name__ == "__main__":
    asyncio.run(test_llm())
