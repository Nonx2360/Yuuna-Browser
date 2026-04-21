import os
import re
import json
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

from llm_client import generate_response, generate_response_stream, generate_agent_response, Message

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

# =============================================
# CHAT SYSTEM PROMPT (Yuuna personality)
# =============================================
def get_system_prompt() -> str:
    try:
        with open(SYSTEM_PROMPT_PATH, "r", encoding="utf-8") as f:
            base_prompt = f.read()
    except Exception as e:
        print(f"Failed to load system prompt: {e}")
        base_prompt = "You are an AI assistant."

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


# =============================================
# AGENT SYSTEM PROMPT (strict ReAct agent)
# =============================================
AGENT_SYSTEM_PROMPT = """You are Yuuna, an autonomous browser agent. Complete the user's goal step-by-step.

## ACTIONS
[ACTION: NAVIGATE | https://url]
[ACTION: GOOGLE_SEARCH | query]
[ACTION: CLICK | text or selector]
[ACTION: TYPE | selector | text]
[ACTION: SCROLL | down]
[ACTION: READ_PAGE]
[ACTION: DONE | friendly answer with data]

## RULES
1. Output ONLY the action tag. Start with [. No chat or thinking.
2. If you navigate to a page, you MUST use READ_PAGE before DONE.
3. DONE must contain the actual information found (titles, facts, etc.).
4. Use the site's own search bar if you are already on the site.
5. TYPE automatically presses Enter. For Wikipedia, use #searchInput.
6. If stuck, try SCROLL or a different CLICK.

## DONE STYLE
Warm and playful voice. Use lists for data.
Example: [ACTION: DONE | I found these top stories for you~! ✨\n- Story 1\n- Story 2]
"""


# =============================================
# PYDANTIC MODELS
# =============================================
class AgentRequest(BaseModel):
    messages: List[Message]
    context: Optional[str] = None

class AgentStepRequest(BaseModel):
    goal: str
    steps_taken: List[Dict[str, Any]] = []
    current_page_state: str

class SynthesizeRequest(BaseModel):
    goal: str
    collected_data: str


# =============================================
# ENDPOINTS
# =============================================

@app.post("/api/chat")
async def chat(request: AgentRequest):
    system_prompt = get_system_prompt()

    full_prompt = system_prompt
    if request.context:
        full_prompt += f"\n\n--- CURRENT BROWSER CONTEXT ---\n{request.context}\n-------------------------------"

    try:
        raw_response_text = await generate_response(request.messages, full_prompt)

        action_payload = None
        action_match = re.search(r"\[ACTION:\s*(NAVIGATE)\s*\|\s*(.*?)\]", raw_response_text, re.IGNORECASE)

        if action_match:
            command = action_match.group(1).strip().upper()
            targetUrl = action_match.group(2).strip()
            clean_text = re.sub(r"\[ACTION:\s*NAVIGATE\s*\|.*?\]", "", raw_response_text, flags=re.IGNORECASE).strip()
            action_payload = {"type": command, "url": targetUrl}
        else:
            clean_text = raw_response_text.strip()

        return {"response": clean_text, "action": action_payload}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat_stream")
async def chat_stream(request: AgentRequest):
    system_prompt = get_system_prompt()

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


@app.post("/api/agent_step")
async def agent_step(request: AgentStepRequest):
    """
    Single-step agentic decision endpoint with improved loop protection.
    """
    try:
        # IMPROVED REGRESSION FIX: Instead of buggy regex, we slice the text more cleanly
        # We look for the "Page Text" marker and truncate it properly.
        current_state = request.current_page_state
        if "Page Text (first 4000 chars):" in current_state:
            parts = current_state.split("Page Text (first 4000 chars):")
            header = parts[0]
            content_and_footer = parts[1]
            
            # Split footer (Interactive Elements)
            footer_marker = "\n\nInteractive Elements:"
            if footer_marker in content_and_footer:
                content_parts = content_and_footer.split(footer_marker)
                page_text = content_parts[0].strip()
                footer = footer_marker + content_parts[1]
            else:
                page_text = content_and_footer.strip()
                footer = ""
            
            # Truncate page text to 1000 chars for small models
            truncated_text = page_text[:1000]
            decision_page_state = f"{header}Page Text (truncated to 1000 chars):\n{truncated_text}\n{footer}"
        else:
            decision_page_state = current_state[:2000] # Fallback truncation

        # Loop protection: if the last 3 steps were all [READ_PAGE], 
        # add a warning to the observation to wake the agent up.
        consecutive_reads = 0
        for s in reversed(request.steps_taken):
            last_action = s.get("action", "")
            if "[ACTION: READ_PAGE]" in last_action or "READ_PAGE" in last_action:
                consecutive_reads += 1
            else:
                break
        
        if consecutive_reads >= 3:
            decision_page_state += "\n\nCRITICAL WARNING: You have read this same page 3 times in a row without making progress. DO NOT use READ_PAGE again. Try a different action like CLICK, TYPE, or NAVIGATE to move forward!"

        raw_action = await generate_agent_response(
            goal=request.goal,
            steps_taken=request.steps_taken,
            current_page_state=decision_page_state,
            system_prompt=AGENT_SYSTEM_PROMPT,
        )

        # REGRESSION FIX: Handling truncation errors from small models
        if raw_action.startswith("[ACTION:") and "]" not in raw_action:
            print(f"[Agent] Repairing truncated action tag: {raw_action!r}")
            raw_action += "]"

        # Extract the [ACTION: ...] tag from the response
        action_match = re.search(
            r"\[ACTION:\s*(\w+)\s*(?:\|\s*([\s\S]*?))?\]",
            raw_action,
            re.IGNORECASE
        )

        if action_match:
            action_tag = action_match.group(0)
        elif not raw_action.strip():
            # If model returned absolutely nothing, force a READ_PAGE or DONE if we've tried too many times
            if consecutive_reads >= 2:
                print("[Agent] Model returned empty string repeatedly. Forcing DONE fallback.")
                action_tag = "[ACTION: DONE | I'm having a little trouble navigating this page~ Could you try being more specific?]"
            else:
                print("[Agent] Model returned empty string. Forcing READ_PAGE fallback.")
                action_tag = "[ACTION: READ_PAGE]"
        else:
            # If model didn't follow format, force a DONE with its raw output
            print(f"[Agent] Model did not return valid action tag. Raw: {raw_action!r}")
            action_tag = f"[ACTION: DONE | {raw_action.strip()[:500]}]"

        print(f"[Agent] Step decision: {action_tag}")
        return {"action": action_tag}

    except Exception as e:
        print(f"[Agent] Error in agent_step: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/synthesize")
async def synthesize(request: SynthesizeRequest):
    """
    Synthesizes a final answer from raw page data collected by the browser agent.
    Uses a focused system prompt so Yuuna reports what she found rather than
    treating it as a new request to browse the web.
    """
    synthesis_prompt = f"""You are Yuuna-chan, the user's warm childhood friend. You have ALREADY browsed the web for the user. The web data has been collected and is shown below.

COLLECTED WEB DATA (from pages you already visited):
---
{request.collected_data[:7000]}
---

INSTRUCTIONS:
- Read the collected data above carefully.
- Answer the user's request using ONLY the information in the collected data.
- Write in your natural Yuuna voice — warm, caring, a little playful.
- Be specific: include actual titles, names, numbers, prices from the data.
- Format lists or tables if there are multiple items.
- DO NOT say "I'll browse" or "Let me open Reddit" — you already have the data.
- DO NOT refuse or say you can't find it — summarize what IS in the data.
- Keep it conversational, 3-6 sentences or a short list."""

    async def gen():
        try:
            async for chunk in generate_response_stream(
                [Message(role="user", content=request.goal)],
                synthesis_prompt
            ):
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/health")
def health_check():
    return {"status": "ok", "message": "Yuuna-chan Backend is running.", "agent_enabled": True}
