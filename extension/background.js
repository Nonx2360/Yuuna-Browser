// background.js — Yuuna Browser Agent v2
// Contains: (1) Normal streaming chat, (2) Full ReAct AgentLoop

let chatHistory = [];

// ============================================================
// MESSAGE ROUTER — handles both chat and agent requests
// ============================================================
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat_stream") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "START_CHAT") return;

    const userText = msg.payload;

    // Add user message to persistent history
    chatHistory.push({ role: "user", content: userText });

    // Detect agent mode
    if (_isAgentRequest(userText)) {
      const goal = _extractAgentGoal(userText);
      const loop = new AgentLoop(goal, port);
      await loop.start();
      return;
    }

    // Normal streaming chat
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) {
        sendStreamToAPI(userText, null, port);
        return;
      }
      const activeTab = tabs[0];
      if (activeTab.url.startsWith("chrome://") || activeTab.url.startsWith("edge://")) {
        sendStreamToAPI(userText, "System Page: No context available.", port);
        return;
      }
      chrome.tabs.sendMessage(activeTab.id, { type: "GET_CONTEXT" }, (response) => {
        const context =
          !chrome.runtime.lastError && response?.context ? response.context : null;
        sendStreamToAPI(userText, context, port);
      });
    });
  });
});

// ── Agent trigger detection ─────────────────────────────────────────────────
// STRICT: only "agent:" prefix triggers agent mode.
// This prevents normal conversational phrases from accidentally routing to the
// agent loop (e.g. "go to sleep", "find me funny", "check this out").
function _isAgentRequest(text) {
  return text.toLowerCase().trim().startsWith("agent:");
}

function _extractAgentGoal(text) {
  return text.replace(/^agent:\s*/i, "").trim();
}


// ============================================================
// AGENTLOOP — full ReAct browser agent
// ============================================================
class AgentLoop {
  constructor(goal, port) {
    this.goal        = goal;
    this.port        = port;
    this.stepsTaken  = [];
    this.agentTabId  = null;
    this.maxSteps    = 15;
    this.currentStep = 0;
    this.stopped     = false;
  }

  // ── Entry point ────────────────────────────────────────────
  async start() {
    this.port.postMessage({ type: "AGENT_START", goal: this.goal });

    // Create a dedicated agent tab (hidden from user focus)
    const tab = await this._createAgentTab();
    this.agentTabId = tab.id;

    // Get initial (blank) page state, then begin loop
    const pageState = await this._observe();
    await this._loop(pageState);
  }

  _createAgentTab() {
    return new Promise((resolve) => {
      chrome.tabs.create({ url: "about:blank", active: false }, resolve);
    });
  }

  // ── Main loop ──────────────────────────────────────────────
  async _loop(pageState) {
    if (this.stopped) return;
    if (this.currentStep >= this.maxSteps) {
      this._abort(`I reached the maximum of ${this.maxSteps} steps without finishing. Sorry!`);
      return;
    }

    this.currentStep++;

    // Ask AI for the next action
    let rawAction;
    try {
      rawAction = await this._decideNextAction(pageState);
    } catch (e) {
      this._abort(`AI decision error: ${e.message}`);
      return;
    }

    // Parse the action tag
    const parsed = this._parseAction(rawAction);
    if (!parsed) {
      this._abort(`Could not understand AI response: "${rawAction}"`);
      return;
    }

    // Send progress to popup
    this.port.postMessage({
      type:        "AGENT_STEP",
      stepNum:     this.currentStep,
      maxSteps:    this.maxSteps,
      action:      parsed.type,
      description: this._describeAction(parsed),
    });

    // Terminal action — deliver final answer
    if (parsed.type === "DONE") {
      const answer = (parsed.payload || "").trim();
      if (answer.length > 30) {
        // Model gave a proper answer — deliver it directly
        this._finish(answer);
      } else {
        // Model said DONE but left the answer blank or trivial.
        // Synthesize a real answer from the page data we already collected.
        await this._synthesizeAndFinish();
      }
      return;
    }

    // Execute the action and capture what happened
    let observation;
    try {
      observation = await this._execute(parsed);
    } catch (e) {
      observation = `Execution error for ${parsed.type}: ${e.message}`;
    }

    // Record step
    this.stepsTaken.push({
      step:        this.currentStep,
      action:      parsed,
      observation: typeof observation === "string" ? observation : JSON.stringify(observation),
    });

    // Wait for the page to settle before observing again
    await this._sleep(1800);
    const newPageState = await this._observe();

    // Next iteration
    await this._loop(newPageState);
  }


  // ── Action parsing ─────────────────────────────────────────
  _parseAction(raw) {
    // Step 1: extract the action TYPE (single word, no newlines)
    const typeMatch = raw.match(/\[ACTION:\s*([A-Z_]+)\s*/i);
    if (!typeMatch) {
      console.warn("[Agent] No action tag found in:", raw.substring(0, 200));
      return null;
    }
    const type = typeMatch[1].toUpperCase().trim();
    const afterType = raw.slice(typeMatch.index + typeMatch[0].length);

    // Step 2: extract ARGS differently per action type
    // For DONE: args can be multi-line (the full answer). Capture everything
    // between the first "|" and the LAST "]" in the response.
    // For other types: args are single-line, stop at first "]"
    let args = "";
    if (type === "DONE") {
      // DONE payload: take everything after "|" until the very last "]"
      const pipeIdx = afterType.indexOf("|");
      if (pipeIdx !== -1) {
        const everything = afterType.slice(pipeIdx + 1);
        // Find the last ] that could be the closing bracket
        const lastBracket = everything.lastIndexOf("]");
        args = (lastBracket !== -1 ? everything.slice(0, lastBracket) : everything).trim();
      }
    } else {
      // Single-line args: take text between "|" and first "]"
      const singleLine = afterType.match(/^\|?([^\]\n]*?)\]/);
      if (singleLine) args = singleLine[1].replace(/^\s*\|\s*/, "").trim();
    }

    return this._buildParsed(type, args);
  }

  _buildParsed(type, args) {
    switch (type) {
      case "NAVIGATE":    return { type, url: args };
      case "SEARCH":      return { type, query: args };
      case "CLICK":       return { type, target: args };
      case "TYPE": {
        // Split "selector | text" on the FIRST pipe only
        const pipe = args.indexOf("|");
        if (pipe === -1) return { type, selector: args.trim(), text: "" };
        return {
          type,
          selector: args.slice(0, pipe).trim(),
          text:     args.slice(pipe + 1).trim(),
        };
      }
      case "PRESS_ENTER": return { type, selector: args || null };
      case "SCROLL":      return { type, direction: args || "down" };
      case "EXTRACT":     return { type, selector: args || null };
      case "READ_PAGE":   return { type };
      case "DONE":        return { type, payload: args };
      default:            return { type, raw: args };
    }
  }

  _describeAction(parsed) {
    switch (parsed.type) {
      case "NAVIGATE":    return `Navigating to ${parsed.url}`;
      case "SEARCH":      return `Searching for "${parsed.query}"`;
      case "CLICK":       return `Clicking "${parsed.target}"`;
      case "TYPE":        return `Typing "${parsed.text}" into ${parsed.selector}`;
      case "PRESS_ENTER": return `Pressing Enter`;
      case "SCROLL":      return `Scrolling ${parsed.direction}`;
      case "EXTRACT":     return `Extracting data from page`;
      case "READ_PAGE":   return `Reading page content`;
      case "DONE":        return `Task complete`;
      default:            return `Executing ${parsed.type}`;
    }
  }


  // ── Action execution ───────────────────────────────────────
  async _execute(parsed) {
    switch (parsed.type) {
      case "NAVIGATE":
        return this._execNavigateAndRead(parsed.url);
      case "SEARCH":
        return this._execNavigateAndRead(`https://www.google.com/search?q=${encodeURIComponent(parsed.query)}`);
      case "CLICK":
        return this._execContent({ type: "AGENT_CLICK",  target:    parsed.target });
      case "TYPE":
        return this._execContent({ type: "AGENT_TYPE",   selector:  parsed.selector, text: parsed.text });
      case "PRESS_ENTER":
        return this._execContent({ type: "AGENT_KEY",    selector:  parsed.selector });
      case "SCROLL":
        return this._execContent({ type: "AGENT_SCROLL", direction: parsed.direction });
      case "EXTRACT":
        return this._execContent({ type: "AGENT_EXTRACT", selector: parsed.selector });
      case "READ_PAGE":
        return this._execContent({ type: "AGENT_READ" });
      default:
        return `Unknown action type: ${parsed.type}`;
    }
  }

  // Navigate AND immediately read the page so the AI always gets content in
  // the observation. This prevents the model from saying DONE on an empty page.
  async _execNavigateAndRead(url) {
    const navResult = await this._execNavigate(url);

    // Give the page extra time to render (heavy sites like Reddit need this)
    await this._sleep(2500);

    // Notify popup that we're also reading the page
    this.port.postMessage({
      type:        "AGENT_STEP",
      stepNum:     this.currentStep,
      maxSteps:    this.maxSteps,
      action:      "READ_PAGE",
      description: "Reading loaded page...",
    });

    const readRaw = await this._execContent({ type: "AGENT_READ" });
    let pageContent = "(could not read page content)";
    try {
      const parsed = JSON.parse(readRaw);
      if (parsed.text) pageContent = parsed.text.substring(0, 5000);
    } catch (_) {
      pageContent = readRaw.substring(0, 5000);
    }

    return `${navResult}\n\n--- PAGE CONTENT ---\n${pageContent}`;
  }

  // Navigate the agent tab to a URL and wait for it to fully load
  _execNavigate(url) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
    }
    return new Promise((resolve) => {
      let resolved = false;
      const done = (result) => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(result);
        }
      };

      // Add the listener BEFORE calling tabs.update to avoid a race condition
      // where the tab completes loading before we start listening.
      const listener = (tabId, changeInfo) => {
        if (tabId === this.agentTabId && changeInfo.status === "complete") {
          done(`Navigated to: ${url}`);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);

      chrome.tabs.update(this.agentTabId, { url }, () => {
        if (chrome.runtime.lastError) {
          done(`Navigation error: ${chrome.runtime.lastError.message}`);
        }
      });

      // Safety timeout: 15 seconds
      setTimeout(() => done(`Navigation timed out for: ${url}`), 15000);
    });
  }

  // Send a message to the content script in the agent tab and get a response.
  // If the content script isn't ready (e.g. freshly navigated tab), we inject
  // it first via the scripting API then retry.
  async _execContent(message) {
    const result = await this._sendToContent(message);
    if (result.startsWith("Content script not ready")) {
      // Inject the content script and retry once
      console.log("[Agent] Content script not ready, injecting...");
      try {
        await chrome.scripting.executeScript({
          target: { tabId: this.agentTabId },
          files:  ["content.js"],
        });
        await this._sleep(300);
      } catch (e) {
        return `Could not inject content script: ${e.message}`;
      }
      return this._sendToContent(message);
    }
    return result;
  }

  _sendToContent(message) {
    return new Promise((resolve) => {
      let resolved = false;
      const done = (r) => { if (!resolved) { resolved = true; resolve(r); } };

      chrome.tabs.sendMessage(this.agentTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          // Distinguish "not ready" from real errors so we can auto-inject
          const err = chrome.runtime.lastError.message || "";
          if (err.includes("Could not establish connection") || err.includes("Receiving end does not exist")) {
            done("Content script not ready");
          } else {
            done(`Content script error: ${err}`);
          }
        } else {
          done(JSON.stringify(response || {}));
        }
      });
      // Safety timeout: 8 seconds
      setTimeout(() => done("Content script timed out"), 8000);
    });
  }

  // Observe the current page state (for AI context)
  async _observe() {
    await this._sleep(1000); // Give the DOM more time to settle (increased for reliability)

    // Use the same retry-inject mechanism as _execContent
    const raw = await this._sendToContent({ type: "AGENT_OBSERVE" });

    if (raw === "Content script not ready") {
      // Try injecting content script
      try {
        await chrome.scripting.executeScript({
          target: { tabId: this.agentTabId },
          files:  ["content.js"],
        });
        await this._sleep(400);
        const retry = await this._sendToContent({ type: "AGENT_OBSERVE" });
        try { return JSON.parse(retry); } catch (_) {}
      } catch (_) {}
      // Give up — return tab info
    }

    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.url) return parsed;
    } catch (_) {}

    // Fallback: basic tab info
    return await new Promise((resolve) => {
      chrome.tabs.get(this.agentTabId, (tab) => {
        resolve({
          url:                  tab?.url   || "about:blank",
          title:                tab?.title || "Loading...",
          text_snippet:         "",
          interactive_elements: [],
          scroll_height:        0,
          scroll_position:      0,
        });
      });
    });
  }


  // ── AI decision ────────────────────────────────────────────
  async _decideNextAction(pageState) {
    // Format interactive elements for the prompt (top 20)
    const elements = (pageState.interactive_elements || [])
      .slice(0, 20)
      .map((el) => {
        let desc = `  [${el.tag}]`;
        if (el.id)          desc += ` #${el.id}`;
        if (el.text)        desc += ` "${el.text}"`;
        if (el.placeholder) desc += ` (placeholder: "${el.placeholder}")`;
        if (el.href)        desc += ` → ${el.href.substring(0, 60)}`;
        return desc;
      })
      .join("\n");

    const pageStateText =
`URL: ${pageState.url}
Title: ${pageState.title}
Page Text (first 4000 chars):
${(pageState.text_snippet || "").substring(0, 4000)}

Interactive Elements:
${elements || "(none detected)"}

Scroll: ${pageState.scroll_position || 0} / ${pageState.scroll_height || 0}`.trim();

    const stepsForAPI = this.stepsTaken.map((s) => ({
      step:        s.step,
      action:      `${s.action.type}: ${JSON.stringify(s.action)}`.substring(0, 200),
      observation: String(s.observation).substring(0, 400),
    }));

    const resp = await fetch("http://127.0.0.1:8000/api/agent_step", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal:               this.goal,
        steps_taken:        stepsForAPI,
        current_page_state: pageStateText,
      }),
    });

    if (!resp.ok) throw new Error(`agent_step API returned ${resp.status}`);
    const data = await resp.json();
    return data.action || "[ACTION: DONE | Something went wrong — could not get next action.]";
  }


  // ── Completion ─────────────────────────────────────────
  _finish(finalAnswer) {
    this.stopped = true;
    chatHistory.push({ role: "assistant", content: finalAnswer });
    chrome.storage.local.set({ chatHistory });
    this._cleanupTab();
    this.port.postMessage({ type: "AGENT_DONE", answer: finalAnswer });
    this.port.postMessage({ type: "DONE" });
  }

  // Called when the model says DONE but provides no useful answer.
  // We take all the page data collected during the agent run and ask
  // the normal chat stream to synthesize a proper Yuuna-style answer.
  async _synthesizeAndFinish() {
    // Notify popup to finalize the step tracker
    this.port.postMessage({ type: "AGENT_DONE", answer: "" });

    // Announce synthesis step
    this.port.postMessage({
      type:        "AGENT_STEP",
      stepNum:     this.currentStep + 1,
      maxSteps:    this.maxSteps,
      action:      "SYNTHESIZE",
      description: "Summarizing what I found~",
    });

    // Gather all page observations collected during the agent run
    const collectedData = this.stepsTaken
      .map((s) => `[Step ${s.step} — ${s.action.type}]:\n${String(s.observation).substring(0, 2000)}`)
      .join("\n\n---\n\n");

    this.stopped = true;
    this._cleanupTab();

    if (!collectedData.trim()) {
      const fallback = "Hmm, I couldn't find anything useful on that page~ Maybe try a different search?";
      chatHistory.push({ role: "assistant", content: fallback });
      chrome.storage.local.set({ chatHistory });
      this.port.postMessage({ type: "CHUNK", data: fallback });
      this.port.postMessage({ type: "DONE" });
      return;
    }

    // Stream the synthesis via the dedicated synthesis endpoint
    try {
      const response = await fetch("http://127.0.0.1:8000/api/synthesize", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal:           this.goal,
          collected_data: collectedData,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader  = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let fullText = "";
      let buffer   = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (const part of parts) {
          if (part.startsWith("data: ")) {
            try {
              const d = JSON.parse(part.substring(6));
              if (d.chunk !== undefined) {
                fullText += d.chunk;
                this.port.postMessage({ type: "CHUNK", data: d.chunk });
              }
            } catch (_) {}
          }
        }
      }

      chatHistory.push({ role: "assistant", content: fullText });
      chrome.storage.local.set({ chatHistory });
      this.port.postMessage({ type: "DONE" });

    } catch (e) {
      console.error("[Agent] Synthesis failed:", e);
      const fallback = "I found the pages but had a little trouble putting it together~ Could you ask me again?";
      chatHistory.push({ role: "assistant", content: fallback });
      chrome.storage.local.set({ chatHistory });
      this.port.postMessage({ type: "CHUNK", data: fallback });
      this.port.postMessage({ type: "DONE" });
    }
  }

  _abort(reason) {
    this.stopped = true;
    const msg = `I had to stop — ${reason}`;
    chatHistory.push({ role: "assistant", content: msg });
    chrome.storage.local.set({ chatHistory });
    this._cleanupTab();
    this.port.postMessage({ type: "AGENT_ERROR", message: reason });
    this.port.postMessage({ type: "DONE" });
  }

  _cleanupTab() {
    if (this.agentTabId !== null) {
      console.log("[Agent] Task finished. Keeping agent tab open for verification.");
      /*
      chrome.tabs.remove(this.agentTabId, () => {
        if (chrome.runtime.lastError) { }
      });
      */
      this.agentTabId = null;
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}


// ============================================================
// NORMAL CHAT STREAM (unchanged from original)
// ============================================================
async function sendStreamToAPI(userText, context, port) {
  try {
    const response = await fetch("http://127.0.0.1:8000/api/chat_stream", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: chatHistory,
        context:  context,
      }),
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const reader  = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullText = "";
    let buffer   = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();

      for (const part of parts) {
        if (part.startsWith("data: ")) {
          try {
            const data = JSON.parse(part.substring(6));
            if (data.chunk !== undefined) {
              fullText += data.chunk;
              port.postMessage({ type: "CHUNK", data: data.chunk });
            } else if (data.error) {
              port.postMessage({ type: "ERROR", message: data.error });
            }
          } catch (e) {
            console.error("Failed to parse chunk", e);
          }
        }
      }
    }

    // Flush remaining buffer
    if (buffer.startsWith("data: ")) {
      try {
        const data = JSON.parse(buffer.substring(6));
        if (data.chunk !== undefined) {
          fullText += data.chunk;
          port.postMessage({ type: "CHUNK", data: data.chunk });
        }
      } catch (_) {}
    }

    chatHistory.push({ role: "assistant", content: fullText });
    chrome.storage.local.set({ chatHistory });

    // Handle simple navigation / search actions from normal chat
    const actionMatch = fullText.match(/\[ACTION:\s*(NAVIGATE|SEARCH)\s*\|\s*(.*?)\]/i);
    if (actionMatch) {
      const type    = actionMatch[1].toUpperCase();
      let payload   = actionMatch[2].trim();
      let url       = "";
      let systemMsg = null;

      if (type === "NAVIGATE") {
        url = payload.startsWith("http") ? payload : "https://" + payload;
        systemMsg = `[System: Yuuna opened ${url}]`;
      } else if (type === "SEARCH") {
        url = `https://www.google.com/search?q=${encodeURIComponent(payload)}`;
        systemMsg = `[System: Yuuna searched for "${payload}" on Google]`;
      }

      if (url) {
        chrome.tabs.create({ url });
        port.postMessage({ type: "ACTION", message: systemMsg });
      }
    }

    port.postMessage({ type: "DONE" });
  } catch (error) {
    console.error("Error connecting to backend:", error);
    port.postMessage({ type: "ERROR", message: error.toString() });
  }
}
