import os
import re
import json
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict

from llm_client import generate_response, generate_response_stream, Message

app = FastAPI(title="Yuuna-chan Browser Agent API")

# Allow requests from the browser extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load the base system prompt from the root directory
SYSTEM_PROMPT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "systemprompt.txt")

def get_system_prompt() -> str:
    try:
        with open(SYSTEM_PROMPT_PATH, "r", encoding="utf-8") as f:
            base_prompt = f.read()
    except Exception as e:
        print(f"Failed to load system prompt: {e}")
        base_prompt = "You are an AI assistant."
        
    # Inject action tag instructions dynamically
    action_instructions = """
    
## Browser Control Capability
You have the ability to control the user's browser. Use these special tags at the VERY END of your response to perform actions:

1. **Navigate**: To open a specific URL.
   [ACTION: NAVIGATE | https://example.com]

2. **Search**: To search Google for a query.
   [ACTION: SEARCH | your search query]

Example Responses:
- "I'll open Google for you! ✨ [ACTION: NAVIGATE | https://google.com]"
- "Let me search for cat videos! 🐾 [ACTION: SEARCH | cat videos]"

Do NOT explain these tags to the user. Only use them when explicitly asked to perform an action.
"""
    return base_prompt + "\n" + action_instructions

class AgentRequest(BaseModel):
    messages: List[Message]
    context: Optional[str] = None

@app.post("/api/chat")
async def chat(request: AgentRequest):
    system_prompt = get_system_prompt()
    
    # If browser context is provided, append it to the system prompt
    full_prompt = system_prompt
    if request.context:
        full_prompt += f"\n\n--- CURRENT BROWSER CONTEXT ---\n{request.context}\n-------------------------------"
        
    try:
        raw_response_text = await generate_response(request.messages, full_prompt)
        
        # Regex to extract [ACTION: COMMAND | PAYLOAD]
        action_payload = None
        action_match = re.search(r"\[ACTION:\s*(NAVIGATE)\s*\|\s*(.*?)\]", raw_response_text, re.IGNORECASE)
        
        if action_match:
            command = action_match.group(1).strip().upper()
            targetUrl = action_match.group(2).strip()
            
            # Remove the tag from the text so the user doesn't see the robotic command
            # we use re.sub to remove the matched pattern from the string
            clean_text = re.sub(r"\[ACTION:\s*NAVIGATE\s*\|.*?\]", "", raw_response_text, flags=re.IGNORECASE).strip()
            
            action_payload = {
                "type": command,
                "url": targetUrl
            }
        else:
            clean_text = raw_response_text.strip()
            
        return {
            "response": clean_text,
            "action": action_payload
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat_stream")
async def chat_stream(request: AgentRequest):
    system_prompt = get_system_prompt()
    
    # If browser context is provided, append it to the system prompt
    full_prompt = system_prompt
    if request.context:
        full_prompt += f"\n\n--- CURRENT BROWSER CONTEXT ---\n{request.context}\n-------------------------------"
        
    async def event_generator():
        try:
            async for chunk in generate_response_stream(request.messages, full_prompt):
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/api/health")
def health_check():
    return {"status": "ok", "message": "Yuuna-chan Backend is running."}

