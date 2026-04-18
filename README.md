# Yuuna-Browser

Yuuna-Browser is an advanced AI browser companion extension integrating locally-run LLMs with dynamic browser control capabilities. Designed to operate strictly on the user's local machine, this project marries an immersive, finely-tuned agentic persona with context-aware web automation.

## Architecture Overview

The system operates across two primary domains: a Python FastAPI backend for inferencing and natural language processing, and a Chromium-based browser extension (Manifest V3) for user interaction and browser automation.

### 1. Backend Service (FastAPI)
The backend acts as the central intelligence node, processing user interactions and DOM context simultaneously. 
- **Endpoint Structure:** Provides RESTful and Streaming responses (`/api/chat` and `/api/chat_stream`) designed for low-latency transmission of both the agent's internal thought process and semantic text.
- **LLM Integration:** Connects to optimized local language models. It dynamically injects browser control directives into the model schema, formatting outputs as strict actionable commands when web navigation is requested.
- **System Prompting:** Utilizes a highly specific system configuration (`systemprompt.txt`) to enforce character alignment while enabling advanced features like dynamic URL navigation and web searches based on user requests.

### 2. Browser Extension (Manifest V3)
The client-side interface seamlessly connects the user's browser environmental context with the intelligence backend.
- **Content Scripts (`content.js`):** Continuously monitors the active tab, extracting critical contextual data to pass to the backend, enabling the AI to "see" the page the user is currently viewing.
- **Service Worker (`background.js`):** Intercepts specific agent actions (e.g., `[ACTION: NAVIGATE]`, `[ACTION: SEARCH]`) stripped from the natural language response and executes native Chrome APIs to alter the user's browser state seamlessly.
- **User Interface (`popup.html` / `popup.js`):** Renders the streaming responses in real-time, handling both standard conversational outputs and internal agent reasoning blocks directly in the browser toolbar.

## How It Works

1. **Context Gathering:** When the user opens the extension, `content.js` pulls the structural or semantic context of the current active webpage.
2. **Request Generation:** The extension packages the user's input alongside the page context and sends a secure asynchronous payload to the local backend.
3. **Inference & Processing:** The FastAPI application merges the request with the base system instructions (which include automation directives) and queries the LLM. 
4. **Action Stripping:** If the AI determines a browser action is necessary, it appends a formatted string (e.g., `[ACTION: SEARCH | target]`). The backend intercepts this string via regular expressions, removing it from the UI feed and converting it into a structured command payload.
5. **Execution:** The extension receives the parsed intelligence. User-facing text is streamed into the conversation DOM, while structural commands are executed by the `background.js` worker to navigate, search, or mutate the browser state.

## Installation & Setup

### Requirements
- Python 3.10+
- A Chromium-based browser (Chrome, Edge, Brave)
- Node.js (Optional, if extending the frontend tooling)
- Appropriate hardware for local LLM inference

### 1. Backend Initialization

Navigate to the root directory and initiate the virtual environment configuration:

```bash
cd backend
python -m venv venv
.\venv\Scripts\activate    # For Windows
source venv/bin/activate  # For POSIX systems

pip install -r requirements.txt
```

Launch the FastAPI server:

```bash
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

### 2. Extension Installation

1. Open your Chromium-based browser and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Select **Load unpacked**.
4. Navigate to the `extension` subdirectory within this repository and select it.
5. The extension is now active and will automatically route requests to the `localhost:8000` instance.

## Technical Scope

This repository focuses rigidly on privacy-first execution. Due to the reliance on locally-hosted large language models for parsing reasoning pathways and action execution, no telemetry or semantic data traverses external networks. All browser manipulation occurs synchronously with explicit user-provided context.

## License

Please refer to the `LICENSE` file for distribution and modification guidelines.
