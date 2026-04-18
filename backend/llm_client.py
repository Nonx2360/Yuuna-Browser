import os
import httpx
from pydantic import BaseModel
from typing import List, Optional

OLLAMA_API_URL = os.environ.get("OLLAMA_API_URL", "http://127.0.0.1:11434")
MODEL_NAME = os.environ.get("MODEL_NAME", "gemma4:e2b")

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[Message]
    context: Optional[str] = None # Webpage context from the browser length

async def generate_response(messages: List[Message], system_prompt: str) -> str:
    """Calls local LLM with the provided messages and system prompt."""
    
    # Prepend the system prompt to the messages list
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
    
    # Prepend the system prompt to the messages list
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
                        import json
                        try:
                            data = json.loads(line)
                            if "message" in data and "content" in data["message"]:
                                yield data["message"]["content"]
                        except json.JSONDecodeError:
                            pass
        except Exception as e:
            print(f"Error streaming from LLM: {e}")
            yield f"Error: Could not connect to the local LLM ({MODEL_NAME}). Make sure it is running."

