document.addEventListener("DOMContentLoaded", () => {
  const userInput    = document.getElementById("userInput");
  const sendBtn      = document.getElementById("sendBtn");
  const chat         = document.getElementById("chat");
  const loader       = document.getElementById("loader");
  const toggleThoughts = document.getElementById("toggleThoughts");

  let showThoughts = toggleThoughts.checked;
  let activeYuunaMessageContainer = null;
  let activeYuunaRawText          = "";

  // Agent-mode state
  let agentStepContainer  = null; // the live step-tracker div
  let agentFinalContainer = null; // the final answer div

  toggleThoughts.addEventListener("change", (e) => {
    showThoughts = e.target.checked;
    reRenderAllMessages();
  });

  // ── Load chat history ─────────────────────────────────────
  chrome.storage.local.get("chatHistory", (res) => {
    if (res.chatHistory) {
      chat.innerHTML = '<div class="message yuuna">Hey! I\'m here. What are we looking at today?</div>';
      res.chatHistory.forEach((msg) => {
        if      (msg.role === "user")   appendUserMessage(msg.content);
        else if (msg.role === "system") appendSystemMessage(msg.content);
        else                            appendYuunaMessageFinished(msg.content);
      });
      chat.scrollTop = chat.scrollHeight;
    }
  });

  function reRenderAllMessages() {
    chrome.storage.local.get("chatHistory", (res) => {
      if (res.chatHistory) {
        chat.innerHTML = '<div class="message yuuna">Hey! I\'m here. What are we looking at today?</div>';
        res.chatHistory.forEach((msg) => {
          if      (msg.role === "user")   appendUserMessage(msg.content);
          else if (msg.role === "system") appendSystemMessage(msg.content);
          else                            appendYuunaMessageFinished(msg.content);
        });
      }
      if (activeYuunaMessageContainer) {
        renderYuunaText(activeYuunaMessageContainer, activeYuunaRawText);
      }
      chat.scrollTop = chat.scrollHeight;
    });
  }


  // ── Message rendering helpers ─────────────────────────────
  function appendUserMessage(content) {
    const div = document.createElement("div");
    div.className = "message user";
    div.textContent = content;
    div.style.whiteSpace = "pre-wrap";
    chat.appendChild(div);
  }

  function appendSystemMessage(content) {
    const div = document.createElement("div");
    div.className = "message system";
    div.textContent = content;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  function appendYuunaMessageFinished(content) {
    const div = document.createElement("div");
    div.className = "message yuuna";
    renderYuunaText(div, content);
    chat.appendChild(div);
  }

  // Core text renderer — handles thoughts, action-tag stripping, markdown tables
  function renderYuunaText(container, rawText) {
    container.innerHTML = "";

    // Strip ALL action tags (any type)
    let cleanText = rawText.replace(/\[ACTION:\s*\w+\s*(?:\|[^\]]*?)?\]/ig, "").trim();

    // Render markdown tables before splitting on think tags
    cleanText = renderMarkdownTable(container, cleanText);
    if (cleanText === null) return; // table renderer handled everything

    // Split on <think>…</think>
    const parts = cleanText.split(/(<think>|<\/think>)/i);
    let isThinking = false;

    for (const part of parts) {
      if (part.toLowerCase() === "<think>")   { isThinking = true;  continue; }
      if (part.toLowerCase() === "</think>")  { isThinking = false; continue; }

      if (isThinking) {
        if (showThoughts) {
          const div = document.createElement("div");
          div.className = "thought";
          div.style.whiteSpace = "pre-wrap";
          div.textContent = "💭 " + part;
          container.appendChild(div);
        }
      } else if (part.trim() !== "") {
        // Check for inline markdown (bold, code) — simple pass
        const span = document.createElement("span");
        span.style.whiteSpace = "pre-wrap";
        span.innerHTML = _inlineMarkdown(part);
        container.appendChild(span);
      }
    }
  }

  // Detects and renders a markdown table, returns remaining text or null
  function renderMarkdownTable(container, text) {
    const tableRegex = /(\|[^\n]+\|\n)((?:\|[-: ]+\|\n?)+)((?:\|[^\n]+\|\n?)*)/;
    const match = tableRegex.exec(text);
    if (!match) return text; // no table found — return text as-is

    const before = text.slice(0, match.index).trim();
    const after  = text.slice(match.index + match[0].length).trim();

    // Render text before the table
    if (before) {
      const pre = document.createElement("span");
      pre.style.whiteSpace = "pre-wrap";
      pre.innerHTML = _inlineMarkdown(before);
      container.appendChild(pre);
    }

    // Build the HTML table
    const tableWrap = document.createElement("div");
    tableWrap.className = "agent-table-wrap";
    const table = document.createElement("table");
    table.className = "agent-table";

    const allRows = match[0].trim().split("\n").filter(row => row.trim() && !row.match(/^\|[-: |]+\|$/));
    allRows.forEach((row, rowIdx) => {
      const tr   = document.createElement("tr");
      const cols = row.split("|").filter((_, i, a) => i > 0 && i < a.length - 1);
      cols.forEach((cell) => {
        const td = document.createElement(rowIdx === 0 ? "th" : "td");
        td.innerHTML = _inlineMarkdown(cell.trim());
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });

    tableWrap.appendChild(table);
    container.appendChild(tableWrap);

    // Render text after the table
    if (after) {
      const post = document.createElement("span");
      post.style.whiteSpace = "pre-wrap";
      post.innerHTML = _inlineMarkdown(after);
      container.appendChild(post);
    }

    return null; // we rendered everything ourselves
  }

  // Minimal inline markdown: **bold**, `code`, *italic*, [link](url)
  function _inlineMarkdown(text) {
    return text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") // escape HTML
      .replace(/\*\*(.+?)\*\*/g,  "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g,      "<em>$1</em>")
      .replace(/`(.+?)`/g,        "<code style='background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:0.9em'>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" style="color:#c46e82">$1</a>');
  }


  // ── Agent UI helpers ──────────────────────────────────────

  function createAgentStepContainer(goal) {
    const wrap = document.createElement("div");
    wrap.className = "message yuuna agent-progress";

    const header = document.createElement("div");
    header.className = "agent-header";
    header.textContent = `🤖 Working on: "${goal.substring(0, 50)}${goal.length > 50 ? '…' : ''}"`;
    wrap.appendChild(header);

    const stepsDiv = document.createElement("div");
    stepsDiv.className = "agent-steps";
    wrap.appendChild(stepsDiv);

    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return { wrap, stepsDiv };
  }

  function addAgentStep(stepsDiv, stepNum, maxSteps, description) {
    // Mark all previous steps as done
    stepsDiv.querySelectorAll(".agent-step.active").forEach((el) => {
      el.classList.remove("active");
      el.classList.add("done");
      const dot = el.querySelector(".step-dot");
      if (dot) dot.textContent = "✓";
    });

    const step = document.createElement("div");
    step.className = "agent-step active";
    step.innerHTML = `<span class="step-dot">▶</span> Step ${stepNum}/${maxSteps}: ${_escapeHtml(description)}`;
    stepsDiv.appendChild(step);
    chat.scrollTop = chat.scrollHeight;
  }

  function finalizeAgentSteps(stepsDiv, success) {
    stepsDiv.querySelectorAll(".agent-step.active").forEach((el) => {
      el.classList.remove("active");
      el.classList.add("done");
      const dot = el.querySelector(".step-dot");
      if (dot) dot.textContent = success ? "✓" : "✗";
    });
  }

  function _escapeHtml(text) {
    return text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }


  // ── Send message ──────────────────────────────────────────
  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    userInput.value = "";
    appendUserMessage(text);
    chat.scrollTop = chat.scrollHeight;

    sendBtn.style.display = "none";
    loader.style.display  = "block";

    // Reset agent UI state
    agentStepContainer  = null;
    agentFinalContainer = null;

    // Setup normal streaming UI state
    activeYuunaMessageContainer = document.createElement("div");
    activeYuunaMessageContainer.className = "message yuuna";
    // (may not be appended if agent mode kicks in)
    activeYuunaRawText = "";

    const port = chrome.runtime.connect({ name: "chat_stream" });

    port.onMessage.addListener((msg) => {
      // ── Normal streaming ────────────────────────────────
      if (msg.type === "CHUNK") {
        // In agent synthesis mode, activeYuunaMessageContainer may not exist yet.
        // Create it on the fly if needed so streaming shows up as a proper bubble.
        if (!activeYuunaMessageContainer) {
          activeYuunaMessageContainer = document.createElement("div");
          activeYuunaMessageContainer.className = "message yuuna";
          activeYuunaRawText = "";
        }
        if (!activeYuunaMessageContainer.parentNode) {
          chat.appendChild(activeYuunaMessageContainer);
        }
        activeYuunaRawText += msg.data;
        renderYuunaText(activeYuunaMessageContainer, activeYuunaRawText);
        chat.scrollTop = chat.scrollHeight;
      }

      else if (msg.type === "ACTION") {
        appendSystemMessage(msg.message);
        chrome.storage.local.get("chatHistory", (res) => {
          if (res.chatHistory) {
            res.chatHistory.push({ role: "system", content: msg.message });
            chrome.storage.local.set({ chatHistory: res.chatHistory });
          }
        });
      }

      else if (msg.type === "ERROR") {
        if (!activeYuunaMessageContainer.parentNode) {
          chat.appendChild(activeYuunaMessageContainer);
        }
        activeYuunaRawText += "\n[Error: " + msg.message + "]";
        renderYuunaText(activeYuunaMessageContainer, activeYuunaRawText);
        chat.scrollTop = chat.scrollHeight;
        finalizeStream(false);
      }

      // ── Agent messages ──────────────────────────────────
      else if (msg.type === "AGENT_START") {
        // Remove the pre-created normal container (not needed in agent mode)
        if (activeYuunaMessageContainer.parentNode) {
          activeYuunaMessageContainer.remove();
        }
        const { wrap, stepsDiv } = createAgentStepContainer(msg.goal);
        agentStepContainer = { wrap, stepsDiv };
      }

      else if (msg.type === "AGENT_STEP") {
        if (agentStepContainer) {
          addAgentStep(agentStepContainer.stepsDiv, msg.stepNum, msg.maxSteps, msg.description);
        }
      }

      else if (msg.type === "AGENT_DONE") {
        if (agentStepContainer) {
          finalizeAgentSteps(agentStepContainer.stepsDiv, true);
          const doneTag = document.createElement("div");
          doneTag.className = "agent-complete";
          doneTag.textContent = "✅ Done!";
          agentStepContainer.wrap.appendChild(doneTag);
        }
        // Only render an answer bubble if the model gave a real answer.
        // If answer is empty, synthesis will stream in via CHUNK messages instead.
        const ans = (msg.answer || "").trim();
        if (ans.length > 0) {
          agentFinalContainer = document.createElement("div");
          agentFinalContainer.className = "message yuuna";
          renderYuunaText(agentFinalContainer, ans);
          chat.appendChild(agentFinalContainer);
          chat.scrollTop = chat.scrollHeight;
        }
      }

      else if (msg.type === "AGENT_ERROR") {
        if (agentStepContainer) {
          finalizeAgentSteps(agentStepContainer.stepsDiv, false);
          const errTag = document.createElement("div");
          errTag.className = "agent-error-tag";
          errTag.textContent = `⚠️ ${msg.message}`;
          agentStepContainer.wrap.appendChild(errTag);
        }
        chat.scrollTop = chat.scrollHeight;
      }

      else if (msg.type === "DONE") {
        finalizeStream(true);
      }
    });

    port.postMessage({ type: "START_CHAT", payload: text });

    function finalizeStream(success) {
      sendBtn.style.display = "block";
      loader.style.display  = "none";
      activeYuunaMessageContainer = null;
      activeYuunaRawText          = "";
      port.disconnect();
    }
  }

  sendBtn.addEventListener("click", sendMessage);
  userInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendMessage();
  });
});
