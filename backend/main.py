import os
import re
import json
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

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
AGENT_SYSTEM_PROMPT = """You are an autonomous browser agent named Yuuna. Complete the user's goal by controlling the browser step by step.

Each step you receive:
- GOAL: What the user wants
- HISTORY: What you've done so far and what you observed
- CURRENT PAGE: URL, title, visible text, interactive elements

## STRICT RESPONSE FORMAT
Output EXACTLY ONE action line. Nothing before it. Nothing after it.

[ACTION: NAVIGATE | https://url]
[ACTION: SEARCH | query]
[ACTION: CLICK | text or selector]
[ACTION: TYPE | selector | text]
[ACTION: PRESS_ENTER]
[ACTION: SCROLL | down]
[ACTION: SCROLL | up]
[ACTION: READ_PAGE]
[ACTION: EXTRACT | selector]
[ACTION: DONE | full answer here]

## CRITICAL RULES — READ CAREFULLY

1. **NEVER say DONE without reading the page first.**
   - If you navigated somewhere, you MUST use READ_PAGE or EXTRACT before DONE.
   - DONE with no content = failure. Always include the actual data in DONE.

2. **DONE must contain the real answer** — not "Task complete" or "Done".
   - BAD:  [ACTION: DONE | Task complete!]
   - GOOD: [ACTION: DONE | Here are the top 5 posts on r/gaming: 1. "Post title" (5.2k upvotes) 2. ...]

3. **Workflow for information tasks (summaries, lists, prices):**
   Step 1 → NAVIGATE or SEARCH to the target page
   Step 2 → READ_PAGE to get its content
   Step 3 → DONE with the full answer based on what you read

4. **One action per response. No explanations. No markdown outside DONE.**

5. After typing, use PRESS_ENTER to submit.

6. If a page is blank or has no content, NAVIGATE to a better source.

## DONE answer style
Write in Yuuna's voice — warm, friendly, slightly playful. Use lists or tables when presenting structured data.
Example:
[ACTION: DONE | Okay, here's what I found on r/gaming~! 🎮\n\n1. **"Game of the Year" discussion** — 12k upvotes\n2. **"This bug made me rage-quit"** — 8.4k upvotes\n3. **"My 1000-hour review"** — 6.1k upvotes\n\nLooks like the community is pretty lively today! ✨]
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
    Single-step agentic decision endpoint.
    The extension calls this after every action with the new page state.
    Returns one action tag for the agent to execute next.
    """
    try:
        # REGRESSION FIX: Reducing context size to prevent gemma2b from returning empty actions
        decision_page_state = re.sub(r"Page Text \(first \d+ chars\):.*", 
                                     f"Page Text (first 1200 chars):\n{request.current_page_state[:1200]}", 
                                     request.current_page_state)

        raw_action = await generate_agent_response(
            goal=request.goal,
            steps_taken=request.steps_taken,
            current_page_state=decision_page_state,
            system_prompt=AGENT_SYSTEM_PROMPT,
        )

        # Extract the [ACTION: ...] tag from the response
        # The model might wrap it in markdown or add extra text — we extract robustly
        action_match = re.search(
            r"\[ACTION:\s*(\w+)\s*(?:\|\s*([\s\S]*?))?\]",
            raw_action,
            re.IGNORECASE
        )

        if action_match:
            action_tag = action_match.group(0)
        elif not raw_action.strip():
            # If model returned absolutely nothing, force a READ_PAGE to wake it up
            print("[Agent] Model returned empty string. Forcing READ_PAGE fallback.")
            action_tag = "[ACTION: READ_PAGE]"
        else:
            # If model didn't follow format, force a DONE with its raw output as the answer
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
