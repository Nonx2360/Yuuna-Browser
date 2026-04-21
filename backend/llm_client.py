import os
import json
import httpx
from pydantic import BaseModel
from typing import List, Optional
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

OLLAMA_API_URL = os.environ.get("OLLAMA_API_URL", "http://127.0.0.1:11434")
MODEL_NAME = os.environ.get("MODEL_NAME", "gemma4:e2b")

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[Message]
    context: Optional[str] = None  # Webpage context from the browser

async def generate_response(messages: List[Message], system_prompt: str) -> str:
    """Calls local LLM with the provided messages and system prompt."""
    formatted_messages = [{"role": "system", "content": system_prompt}]
    for msg in messages:
        formatted_messages.append({"role": msg.role, "content": msg.content})

    payload = {
        "model": MODEL_NAME,
        "messages": formatted_messages,
        "stream": False
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(f"{OLLAMA_API_URL}/api/chat", json=payload, timeout=60.0)
            response.raise_for_status()
            data = response.json()
            return data.get("message", {}).get("content", "Error: No content returned")
        except Exception as e:
            print(f"Error calling LLM: {e}")
            return f"Error: Could not connect to the local LLM ({MODEL_NAME}). Make sure it is running."

async def generate_response_stream(messages: List[Message], system_prompt: str):
    """Calls local LLM with the provided messages and streams the response."""
    formatted_messages = [{"role": "system", "content": system_prompt}]
    for msg in messages:
        formatted_messages.append({"role": msg.role, "content": msg.content})

    payload = {
        "model": MODEL_NAME,
        "messages": formatted_messages,
        "stream": True
    }

    async with httpx.AsyncClient() as client:
        try:
            async with client.stream("POST", f"{OLLAMA_API_URL}/api/chat", json=payload, timeout=60.0) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line:
                        try:
                            data = json.loads(line)
                            if "message" in data and "content" in data["message"]:
                                yield data["message"]["content"]
                        except json.JSONDecodeError:
                            pass
        except Exception as e:
            print(f"Error streaming from LLM: {e}")
            yield f"Error: Could not connect to the local LLM ({MODEL_NAME}). Make sure it is running."

async def generate_agent_response(goal: str, steps_taken: list, current_page_state: str, system_prompt: str) -> str:
    """
    Calls the LLM for a single agent step decision.
    Returns exactly one [ACTION: ...] tag.
    Optimized for speed: non-streaming, focused context.
    """
    # Build the history section
    history_lines = []
    for step in steps_taken:
        history_lines.append(
            f"Step {step.get('step', '?')}: {step.get('action', '')} → {str(step.get('observation', ''))[:300]}"
        )
    history_text = "\n".join(history_lines) if history_lines else "(No steps taken yet — this is the first step.)"

    # Build the prompt as a single user message
    user_content = f"""GOAL: {goal}

HISTORY OF STEPS TAKEN:
{history_text}

CURRENT PAGE STATE:
{current_page_state}

What is your next single action?"""

    formatted_messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content}
    ]

    payload = {
        "model": MODEL_NAME,
        "messages": formatted_messages,
        "stream": False,
        "options": {
            "temperature": 0.1,   # Low temp for deterministic action decisions
            "num_predict": 1024,   # Extra room for preamble or long URLs
        }
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(f"{OLLAMA_API_URL}/api/chat", json=payload, timeout=45.0)
            response.raise_for_status()
            data = response.json()
            return data.get("message", {}).get("content", "").strip()
        except Exception as e:
            print(f"Error calling agent LLM: {e}")
            return f"[ACTION: DONE | Error: Could not reach the AI model — {str(e)}]"
