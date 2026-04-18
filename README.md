# Yuuna-Browser

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white" />
  <img src="https://img.shields.io/badge/Chrome%20Extension-4285F4?style=flat-square&logo=google-chrome&logoColor=white" />
  <img src="https://img.shields.io/badge/Manifest%20V3-FF6B6B?style=flat-square" />
  <img src="https://img.shields.io/badge/Privacy-First-2ECC71?style=flat-square" />
</p>

Yuuna-Browser is an **AI-powered browser companion** that integrates locally-run Large Language Models (LLMs) with dynamic browser control capabilities. It features a fully immersive, agentic persona (Yuuna-chan) that can "see" what you're browsing and actively help navigate the web — all while running entirely on your local machine for maximum privacy.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
  - [System Architecture Diagram](#system-architecture-diagram)
  - [Data Flow Diagram](#data-flow-diagram)
  - [Component Interaction Map](#component-interaction-map)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
  - [1. Context Gathering](#1-context-gathering)
  - [2. Request Generation](#2-request-generation)
  - [3. AI Inference & Processing](#3-ai-inference--processing)
  - [4. Action Parsing & Execution](#4-action-parsing--execution)
  - [5. Response Streaming](#5-response-streaming)
- [Components Deep Dive](#components-deep-dive)
  - [Backend (FastAPI)](#backend-fastapi)
  - [Browser Extension](#browser-extension)
  - [LLM Integration](#llm-integration)
- [Installation & Setup](#installation--setup)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Privacy & Security](#privacy--security)
- [License](#license)

---

## Architecture Overview

Yuuna-Browser operates as a **distributed client-server architecture** with two primary domains:

| Domain | Technology | Purpose |
|--------|------------|---------|
| **Backend** | Python + FastAPI | AI inference, natural language processing, action orchestration |
| **Frontend** | Chrome Extension (Manifest V3) | User interface, browser automation, context extraction |
| **LLM Engine** | Ollama (Local) | On-device model inference (default: `gemma4:e2b`) |

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           YUUNA-BROWSER ARCHITECTURE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                         CHROMIUM BROWSER                                ││
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────────────┐ ││
│  │  │   POPUP UI      │  │  CONTENT SCRIPT │  │   SERVICE WORKER       │ ││
│  │  │  (popup.html)   │  │   (content.js)  │  │    (background.js)     │ ││
│  │  │  ┌───────────┐  │  │                 │  │                        │ ││
│  │  │  │ popup.js  │◄─┼──┼─► Extracts    │  │  ┌──────────────────┐  │ ││
│  │  │  │           │  │  │    page context │  │  │ Message Handler  │  │ ││
│  │  │  │ • Chat UI │  │  │                 │  │  │ • Action Parser  │  │ ││
│  │  │  │ • History │  │  │  URL, Title,    │  │  │ • Tab Controller │  │ ││
│  │  │  │ • Stream  │◄─┼──┼─► Text Content  │  │  │ • History Store  │  │ ││
│  │  │  └───────────┘  │  │                 │  │  └────────┬─────────┘  │ ││
│  │  └─────────────────┘  └─────────────────┘  └─────────│──────────────┘ ││
│  │           ▲                                         │                ││
│  │           │            Chrome Runtime APIs           │                ││
│  └───────────┼──────────────────────────────────────────┼────────────────┘│
│              │                                          │                 │
│              │ HTTP/SSE Stream                          │ Chrome API      │
│              │ (localhost:8000)                       │ (tabs.create)   │
│              ▼                                          ▼                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                      FASTAPI BACKEND (Python)                         ││
│  │  ┌─────────────────────────────────────────────────────────────────┐  ││
│  │  │                        main.py                                  │  ││
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │  ││
│  │  │  │ /api/chat    │  │ /api/chat_   │  │    /api/health       │ │  ││
│  │  │  │              │  │    stream    │  │                      │ │  ││
│  │  │  │ • REST API   │  │ • SSE Stream │  │  Health check        │ │  ││
│  │  │  │ • Action     │  │ • Real-time  │  │                      │ │  ││
│  │  │  │   Extraction │  │   response   │  └──────────────────────┘ │  ││
│  │  │  └──────┬───────┘  └──────┬───────┘                           │  ││
│  │  │         │                 │                                   │  ││
│  │  │         └────────┬────────┘                                   │  ││
│  │  │                  ▼                                            │  ││
│  │  │  ┌────────────────────────────────────────────────────────┐  │  ││
│  │  │  │                   llm_client.py                         │  │  ││
│  │  │  │  ┌─────────────┐      ┌─────────────┐                   │  │  ││
│  │  │  │  │  generate_  │      │  generate_  │                   │  │  ││
│  │  │  │  │  response() │      │  response_  │                   │  │  ││
│  │  │  │  │             │      │  stream()   │                   │  │  ││
│  │  │  │  │  Blocking   │      │  Streaming  │                   │  │  ││
│  │  │  │  └──────┬──────┘      └──────┬──────┘                   │  │  ││
│  │  │  └─────────│───────────────────│────────────────────────────┘  │  ││
│  │  └────────────│───────────────────│───────────────────────────────┘  ││
│  │               │                   │                                    ││
│  │               │  HTTP POST        │  HTTP POST                       ││
│  │               │  /api/chat        │  /api/chat (stream=True)         ││
│  │               ▼                   ▼                                    ││
│  │  ┌────────────────────────────────────────────────────────────────┐  ││
│  │  │                      OLLAMA (Local LLM)                        │  ││
│  │  │                 Default: gemma4:e2b @ :11434                    │  ││
│  │  │                                                                  │  ││
│  │  │  ┌──────────────────────────────────────────────────────────┐ │  ││
│  │  │  │ systemprompt.txt + Browser Context + User Message        │ │  ││
│  │  │  │                    ↓                                     │ │  ││
│  │  │  │              LLM Inference                               │ │  ││
│  │  │  │                    ↓                                     │ │  ││
│  │  │  │  Response + [ACTION: TYPE | payload]                   │ │  ││
│  │  │  └──────────────────────────────────────────────────────────┘ │  ││
│  │  └────────────────────────────────────────────────────────────────┘  ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Diagram

```
┌──────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  USER    │────►│   POPUP     │────►│  BACKGROUND  │────►│   CONTENT   │
│  INPUT   │     │   popup.js  │     │ background.js│     │  content.js │
└──────────┘     └─────────────┘     └──────┬───────┘     └──────┬──────┘
                                          │                     │
                                          │  1. Query Tab       │
                                          │────────────────────►│
                                          │                     │
                                          │  2. Return Context  │
                                          │◄────────────────────│
                                          │  (URL, Title, Text) │
                                          │
                                          ▼
                              ┌─────────────────────┐
                              │  3. Send POST to    │
                              │  /api/chat_stream   │
                              │  with messages +    │
                              │  context            │
                              └──────────┬──────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │   FASTAPI SERVER    │
                              │     main.py         │
                              │  • Build prompt     │
                              │  • Call LLM         │
                              └──────────┬──────────┘
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │   OLLAMA (Local)    │
                              │  • Process request  │
                              │  • Generate tokens  │
                              └──────────┬──────────┘
                                         │
                                         │ SSE Stream
                                         ▼
                              ┌─────────────────────┐
                              │  4. Stream chunks   │
                              │  back to extension  │
                              └──────────┬──────────┘
                                         │
                              ┌──────────┴──────────┐
                              ▼                     ▼
                    ┌─────────────┐         ┌─────────────┐
                    │  DISPLAY    │         │   ACTION    │
                    │  RESPONSE   │         │   DETECTED  │
                    │  in chat UI │         │             │
                    └─────────────┘         │ Parse tags: │
                                          │ [ACTION:...] │
                                          └──────┬──────┘
                                                 │
                                                 ▼
                                       ┌─────────────────┐
                                       │  5. Execute via │
                                       │  chrome.tabs.*  │
                                       │  (Navigate/     │
                                       │   Search)       │
                                       └─────────────────┘
```

### Component Interaction Map

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           COMPONENT MATRIX                               │
├─────────────────────┬──────────────────────┬──────────────────────────────┤
│     Component       │    Communicates With │          Purpose             │
├─────────────────────┼──────────────────────┼──────────────────────────────┤
│ popup.html/js       │ background.js (Port) │ User interface, chat display │
│                     │ chrome.storage       │ History persistence          │
├─────────────────────┼──────────────────────┼──────────────────────────────┤
│ background.js       │ popup.js (Port)      │ Message broker, coordinator  │
│                     │ content.js (Msg)     │ Context request/response     │
│                     │ FastAPI (HTTP/SSE)   │ AI backend communication     │
│                     │ chrome.tabs API      │ Browser action execution     │
├─────────────────────┼──────────────────────┼──────────────────────────────┤
│ content.js          │ background.js (Msg)  │ DOM context extraction       │
│                     │ Active Tab DOM       │ URL, title, text content     │
├─────────────────────┼──────────────────────┼──────────────────────────────┤
│ main.py (FastAPI)   │ llm_client.py        │ API endpoints, routing       │
│                     │ Ollama (HTTP)        │ Action parsing via regex     │
├─────────────────────┼──────────────────────┼──────────────────────────────┤
│ llm_client.py       │ Ollama API (:11434)  │ LLM communication layer      │
│                     │ main.py              │ Sync & streaming responses   │
├─────────────────────┼──────────────────────┼──────────────────────────────┤
│ systemprompt.txt    │ llm_client.py        │ Personality & instructions   │
│                     │ (loaded at runtime)  │ Action tag definitions       │
└─────────────────────┴──────────────────────┴──────────────────────────────┘
```

---

## Project Structure

```
Browser_YUUNA/
│
├── 📁 backend/                    # FastAPI Python Backend
│   ├── main.py                    # API endpoints & action parsing
│   ├── llm_client.py              # Ollama LLM integration
│   ├── requirements.txt           # Python dependencies
│   └── __pycache__/               # Compiled Python cache
│
├── 📁 extension/                  # Chrome Extension (Manifest V3)
│   ├── manifest.json              # Extension configuration
│   ├── background.js              # Service worker (core logic)
│   ├── content.js                 # Page context extraction
│   ├── popup.html                 # Extension UI markup
│   └── popup.js                   # Extension UI logic
│
├── systemprompt.txt               # Yuuna-chan personality definition
├── LICENSE                        # License file
├── README.md                      # This file
├── .gitignore                     # Git ignore rules
└── venv/                          # Python virtual environment
```

---

## How It Works

### 1. Context Gathering

When you open the Yuuna-chan extension popup:

| Step | Component | Action |
|------|-----------|--------|
| 1a | `background.js` | Queries Chrome for the active tab |
| 1b | `content.js` | Receives `GET_CONTEXT` message from background |
| 1c | `content.js` | Extracts `URL`, `Title`, and first 3000 chars of page text |
| 1d | `content.js` | Returns context object to background |

**Code Flow:**
```
background.js ──[GET_CONTEXT]──► content.js ──► document.body.innerText
                                        │
                                        ▼
                              Extract: URL, Title, Text
                                        │
background.js ◄──[response.context]──────┘
```

### 2. Request Generation

The extension assembles a complete payload:

```json
{
  "messages": [
    { "role": "user", "content": "What is this page about?" }
  ],
  "context": "URL: https://example.com\nTitle: Example Page\nContent Snippet: Lorem ipsum..."
}
```

This is sent to `POST /api/chat_stream` on the FastAPI backend.

### 3. AI Inference & Processing

**Backend Processing Pipeline:**

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────┐
│ Raw Request │───►│ Build Prompt │───►│ Query Ollama │───►│ Response │
└─────────────┘    └──────────────┘    └──────────────┘    └──────────┘

Prompt Construction:
├── systemprompt.txt (Personality)
├── Browser Control Instructions (Action tags)
├── Current Browser Context (URL, Title, Content)
└── Chat History + New User Message
```

**Action Tag Format:**
The LLM is instructed to append special tags when it wants to perform browser actions:

```
[ACTION: NAVIGATE | https://google.com]     → Open URL
[ACTION: SEARCH | cat videos]               → Google search
```

### 4. Action Parsing & Execution

**Regex Extraction Pattern:**
```python
action_match = re.search(
    r"\[ACTION:\s*(NAVIGATE|SEARCH)\s*\|\s*(.*?)\]",
    response_text,
    re.IGNORECASE
)
```

**Execution Flow:**
```
AI Response
    │
    ├──► Clean Text ──► Stream to UI (chat message)
    │
    └──► [ACTION:...] ──► Parse Command ──► Execute via Chrome API
                                  │
                                  ├── NAVIGATE ──► chrome.tabs.create({url})
                                  └── SEARCH ────► chrome.tabs.create({
                                                      url: "google.com/search?q=..."
                                                   })
```

### 5. Response Streaming

Yuuna-chan uses **Server-Sent Events (SSE)** for real-time responses:

```
Ollama ──► llm_client ──► FastAPI ──► HTTP/SSE ──► background.js ──► popup.js
  │          │              │              │              │
  │          │              │              │              │
Tokens    Chunks         Event Stream   Parse chunks   Render in DOM
```

**Special Rendering Features:**
- **Thought Blocks** (`<think>...</think>`): Optional internal reasoning display
- **Action Tag Stripping**: Hidden from user view, executed silently
- **Markdown-like formatting**: Preserved whitespace via `white-space: pre-wrap`

---

## Components Deep Dive

### Backend (FastAPI)

#### `main.py` - API Layer

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Health check endpoint |
| `/api/chat` | POST | Synchronous chat (blocking) |
| `/api/chat_stream` | POST | Streaming chat (SSE) |

**Key Functions:**
- `get_system_prompt()` - Loads and injects action instructions into base prompt
- `chat()` - Non-streaming endpoint with action extraction
- `chat_stream()` - Streaming endpoint for real-time responses

**Action Extraction Regex:**
```python
r"\[ACTION:\s*(NAVIGATE)\s*\|\s*(.*?)\]"
```

#### `llm_client.py` - LLM Integration

| Function | Mode | Use Case |
|----------|------|----------|
| `generate_response()` | Blocking | Simple requests, full response needed |
| `generate_response_stream()` | Streaming | Real-time chat, progressive display |

**Configuration:**
```python
OLLAMA_API_URL = "http://127.0.0.1:11434"  # Ollama default
MODEL_NAME = "gemma4:e2b"                  # Configurable via env
```

### Browser Extension

#### `manifest.json` - Extension Config

```json
{
  "manifest_version": 3,
  "permissions": ["activeTab", "scripting", "storage"],
  "host_permissions": [
    "http://127.0.0.1:8000/*",  // Backend access
    "<all_urls>"                // Page context extraction
  ]
}
```

**Architecture:** Manifest V3 with:
- **Service Worker** (`background.js`) - Event-driven background processing
- **Content Script** (`content.js`) - Injected into web pages
- **Action Popup** (`popup.html/js`) - User interface

#### `background.js` - Core Orchestrator

**Event Listeners:**
1. `chrome.runtime.onConnect` - Handles popup connections
2. Port message listener - Processes chat requests

**State Management:**
- `chatHistory[]` - In-memory conversation history
- `chrome.storage.local` - Persistent history backup

**Action Execution:**
```javascript
// Navigation
chrome.tabs.create({ url: url });

// Search
chrome.tabs.create({
  url: `https://www.google.com/search?q=${encodeURIComponent(query)}`
});
```

#### `content.js` - Context Extractor

**Message Handler:**
```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_CONTEXT") {
    const context = {
      url: window.location.href,
      title: document.title,
      text: document.body.innerText.substring(0, 3000)
    };
    sendResponse({ context });
  }
});
```

**Safety Features:**
- Skips `chrome://` and `edge://` pages (browser internals)
- Text length limited to 3000 chars (LLM context window protection)
- Regex cleanup for whitespace normalization

#### `popup.js` - User Interface

**UI Components:**
- Chat display container with auto-scroll
- User input field with Enter-key support
- Send button / Loading spinner toggle
- "Show Thoughts" checkbox for debug visibility

**Message Rendering:**
- Parses `<think>` blocks (optional display)
- Strips action tags before display
- Applies different styling for user/Yuuna/system messages

### LLM Integration

#### `systemprompt.txt` - Personality Engine

Yuuna-chan's personality is defined through:

| Aspect | Implementation |
|--------|---------------|
| **Persona** | Childhood friend since elementary school |
| **Tone** | Warm, intimate, slightly teasing, occasionally flustered |
| **Response Length** | 2-3 sentences (60-250 chars) |
| **Memory Integration** | Random nostalgic callbacks |
| **Constraints** | No formal language, no transactional questions |

**Dynamic Instructions Injection:**
The backend appends browser control instructions at runtime:
```
## Browser Control Capability
You have the ability to control the user's browser...

1. **Navigate**: [ACTION: NAVIGATE | https://example.com]
2. **Search**: [ACTION: SEARCH | query]
```

---

## Installation & Setup

### Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Python | 3.10+ | Backend runtime |
| Chromium Browser | Latest | Extension host |
| Ollama | Latest | Local LLM inference |
| pip | Latest | Python package management |

### 1. Install Ollama

Download and install from [ollama.com](https://ollama.com), then pull the model:

```bash
ollama pull gemma4:e2b
```

### 2. Backend Setup

```bash
# Navigate to backend directory
cd backend

# Create virtual environment
python -m venv venv

# Activate environment
# Windows:
.\venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

**Dependencies:**
```
fastapi        # Web framework
uvicorn        # ASGI server
httpx          # Async HTTP client
pydantic       # Data validation
python-dotenv  # Environment variables
```

### 3. Start Backend

```bash
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Expected output:
```
INFO:     Started server process [xxxxx]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000
```

### 4. Install Extension

1. Open Chrome/Edge/Brave and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repository
5. Pin the extension to your toolbar (optional)

**Verification:**
- Extension icon should appear in toolbar
- Clicking should open popup with "Hey! I'm here. What are we looking at today?"

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_API_URL` | `http://127.0.0.1:11434` | Ollama server endpoint |
| `MODEL_NAME` | `gemma4:e2b` | Model to use for inference |

**Example (Windows PowerShell):**
```powershell
$env:OLLAMA_API_URL = "http://localhost:11434"
$env:MODEL_NAME = "llama3.1:8b"
uvicorn main:app --host 127.0.0.1 --port 8000
```

**Example (Linux/macOS):**
```bash
export OLLAMA_API_URL="http://localhost:11434"
export MODEL_NAME="llama3.1:8b"
uvicorn main:app --host 127.0.0.1 --port 8000
```

### Customizing the Personality

Edit `systemprompt.txt` to modify Yuuna-chan's behavior. The file is loaded at runtime, so changes take effect immediately (no restart needed for non-streaming, restart connection for streaming).

---

## API Reference

### Endpoints

#### `GET /api/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "message": "Yuuna-chan Backend is running."
}
```

#### `POST /api/chat`
Non-streaming chat endpoint.

**Request Body:**
```json
{
  "messages": [
    { "role": "user", "content": "Hello Yuuna!" }
  ],
  "context": "URL: https://example.com\nTitle: Example"
}
```

**Response:**
```json
{
  "response": "Hey there! *smiles* Remember when we used to...",
  "action": {
    "type": "NAVIGATE",
    "url": "https://google.com"
  }
}
```

#### `POST /api/chat_stream`
Streaming chat endpoint (Server-Sent Events).

**Request Body:** Same as `/api/chat`

**Response Format:**
```
data: {"chunk": "Hello"}

data: {"chunk": " there"}

data: {"chunk": "!"}

data: {"error": "..."}  // If error occurs
```

---

## Privacy & Security

### Privacy-First Design

| Aspect | Implementation |
|--------|---------------|
| **Data Locality** | All processing on localhost |
| **No External Calls** | LLM runs locally via Ollama |
| **No Telemetry** | No analytics or tracking |
| **Context Scope** | Only active tab, only when requested |
| **Storage** | Local-only, no cloud sync |

### Security Considerations

- **CORS**: Configured to allow all origins (development convenience)
- **Action Validation**: URLs validated before navigation
- **Content Script Isolation**: Runs in isolated world, no page JS access
- **HTTPS Recommendation**: For production, use HTTPS backend

### Data Flow Security

```
User Input ──► Local Extension ──► Local Backend ──► Local LLM
     │                │                  │               │
     │                │                  │               │
     ▼                ▼                  ▼               ▼
  [NEVER]          [NEVER]            [NEVER]         [NEVER]
   Leaves           Leaves             Leaves          Leaves
   Device           Device             Device          Device
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Error connecting to backend" | Backend not running | Start uvicorn server |
| "Could not connect to LLM" | Ollama not running | Start Ollama service |
| Extension popup blank | Port connection failed | Check backend health at `/api/health` |
| Actions not executing | Action tag malformed | Check browser console for errors |
| Slow responses | Model too large | Use smaller model or quantize |

### Debug Checklist

1. ✅ Backend running: `curl http://127.0.0.1:8000/api/health`
2. ✅ Ollama running: `ollama list` shows your model
3. ✅ Extension loaded: Visible in `chrome://extensions/`
4. ✅ Console logs: Check DevTools for background/popup

---

## License

This project is licensed under the terms specified in the `LICENSE` file.

---

## Acknowledgments

- Built with [FastAPI](https://fastapi.tiangolo.com/) for the backend
- Powered by [Ollama](https://ollama.com) for local LLM inference
- Chrome Extension APIs via [Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro/)

---

<p align="center">
  <sub>Built with ❤️ for local-first AI browsing experiences</sub>
</p>
