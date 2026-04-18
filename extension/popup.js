document.addEventListener("DOMContentLoaded", () => {
  const userInput = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  const chat = document.getElementById("chat");
  const loader = document.getElementById("loader");
  const toggleThoughts = document.getElementById("toggleThoughts");

  let showThoughts = toggleThoughts.checked;
  let activeYuunaMessageContainer = null;
  let activeYuunaRawText = ""; 
  
  toggleThoughts.addEventListener("change", (e) => {
    showThoughts = e.target.checked;
    reRenderAllMessages();
  });

  // Load chat history from storage if needed
  chrome.storage.local.get("chatHistory", (res) => {
    if (res.chatHistory) {
      chat.innerHTML = '<div class="message yuuna">Hey! I\'m here. What are we looking at today?</div>';
      res.chatHistory.forEach(msg => {
          if (msg.role === "user") {
              appendUserMessage(msg.content);
          } else if (msg.role === "system") {
              appendSystemMessage(msg.content);
          } else {
              appendYuunaMessageFinished(msg.content);
          }
      });
      chat.scrollTop = chat.scrollHeight;
    }
  });
  
  function reRenderAllMessages() {
     chrome.storage.local.get("chatHistory", (res) => {
        if (res.chatHistory) {
          chat.innerHTML = '<div class="message yuuna">Hey! I\'m here. What are we looking at today?</div>';
          res.chatHistory.forEach(msg => {
              if (msg.role === "user") {
                  appendUserMessage(msg.content);
              } else if (msg.role === "system") {
                  appendSystemMessage(msg.content);
              } else {
                  appendYuunaMessageFinished(msg.content);
              }
          });
        }
        // Also re-render whatever is currently accumulating
        if (activeYuunaMessageContainer) {
            renderYuunaText(activeYuunaMessageContainer, activeYuunaRawText);
        }
        chat.scrollTop = chat.scrollHeight;
     });
  }

  function appendUserMessage(content) {
    const div = document.createElement("div");
    div.className = "message user";
    // Using innerText preserves spaces/newlines natively in DOM, or safe assignment:
    div.textContent = content; 
    div.style.whiteSpace = "pre-wrap";
    chat.appendChild(div);
  }
  
  function appendSystemMessage(content) {
    const div = document.createElement("div");
    div.className = "message system";
    div.style.backgroundColor = "transparent";
    div.style.color = "#aaaaaa";
    div.style.fontSize = "0.8em";
    div.style.fontStyle = "italic";
    div.style.textAlign = "center";
    div.style.alignSelf = "center";
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

  function renderYuunaText(container, rawText) {
    container.innerHTML = "";
    
    // Hide action tag completely
    let cleanText = rawText.replace(/\[ACTION:\s*NAVIGATE.*?(?:\|.*?\]|\]|$)/ig, "");
    
    // Parse <think> areas
    let parts = cleanText.split(/(<think>|<\/think>)/i);
    
    let isThinking = false;
    for (let part of parts) {
        if (part.toLowerCase() === '<think>') {
            isThinking = true;
            continue;
        }
        if (part.toLowerCase() === '</think>') {
            isThinking = false;
            continue;
        }
        
        if (isThinking) {
            if (showThoughts) {
                let div = document.createElement("div");
                div.className = "thought";
                div.style.whiteSpace = "pre-wrap";
                div.textContent = "💭 " + part;
                container.appendChild(div);
            }
        } else {
            if (part !== "") {
                let span = document.createElement("span");
                span.style.whiteSpace = "pre-wrap";
                span.textContent = part;
                container.appendChild(span);
            }
        }
    }
  }

  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    userInput.value = "";
    appendUserMessage(text);
    chat.scrollTop = chat.scrollHeight;
    
    sendBtn.style.display = "none";
    loader.style.display = "block";

    // Setup streaming UI state
    activeYuunaMessageContainer = document.createElement("div");
    activeYuunaMessageContainer.className = "message yuuna";
    chat.appendChild(activeYuunaMessageContainer);
    activeYuunaRawText = "";

    // Connect to background script
    const port = chrome.runtime.connect({ name: "chat_stream" });
    
    port.onMessage.addListener((msg) => {
      if (msg.type === "CHUNK") {
        activeYuunaRawText += msg.data;
        renderYuunaText(activeYuunaMessageContainer, activeYuunaRawText);
        chat.scrollTop = chat.scrollHeight;
      } 
      else if (msg.type === "ACTION") {
        appendSystemMessage(msg.message);
        
        // Ensure system messages are also logged in history
        chrome.storage.local.get("chatHistory", (res) => {
           if (res.chatHistory) {
               res.chatHistory.push({ role: "system", content: msg.message });
               chrome.storage.local.set({ chatHistory: res.chatHistory });
           } 
        });
      }
      else if (msg.type === "ERROR") {
        activeYuunaRawText += "\n[Error: " + msg.message + "]";
        renderYuunaText(activeYuunaMessageContainer, activeYuunaRawText);
        chat.scrollTop = chat.scrollHeight;
        finalizeStream();
      }
      else if (msg.type === "DONE") {
        finalizeStream();
      }
    });

    port.postMessage({ type: "START_CHAT", payload: text });

    function finalizeStream() {
      sendBtn.style.display = "block";
      loader.style.display = "none";
      activeYuunaMessageContainer = null;
      activeYuunaRawText = "";
      port.disconnect();
    }
  }

  sendBtn.addEventListener("click", sendMessage);
  userInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendMessage();
  });
});
