// background.js

let chatHistory = [];

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "chat_stream") {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === "START_CHAT") {
        
        // Add user message to local history
        chatHistory.push({ role: "user", content: msg.payload });
        
        // Try to get current active tab to grab context
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length === 0) {
            sendStreamToAPI(msg.payload, null, port);
            return;
          }

          const activeTab = tabs[0];
          
          // Don't inject into special chrome:// or edge:// pages
          if (activeTab.url.startsWith("chrome://") || activeTab.url.startsWith("edge://")) {
            sendStreamToAPI(msg.payload, "System Page: No context available.", port);
            return;
          }

          // Ask content script for context
          chrome.tabs.sendMessage(activeTab.id, { type: "GET_CONTEXT" }, (response) => {
            let context = null;
            if (!chrome.runtime.lastError && response && response.context) {
              context = response.context;
            }
            sendStreamToAPI(msg.payload, context, port);
          });
        });
      }
    });
  }
});

async function sendStreamToAPI(userText, context, port) {
  try {
    const response = await fetch("http://127.0.0.1:8000/api/chat_stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messages: chatHistory,
        context: context
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      let parts = buffer.split('\n\n');
      buffer = parts.pop();
      
      for (const part of parts) {
        if (part.startsWith('data: ')) {
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
    
    // Process any remaining partial string
    if (buffer.startsWith('data: ')) {
        try {
            const data = JSON.parse(buffer.substring(6));
            if (data.chunk !== undefined) {
                fullText += data.chunk;
                port.postMessage({ type: "CHUNK", data: data.chunk });
            }
        } catch (e) {}
    }

    chatHistory.push({ role: "assistant", content: fullText });
    chrome.storage.local.set({ chatHistory });

    let systemMessage = null;

    // Handle any requested actions from the backend
    const actionMatch = fullText.match(/\[ACTION:\s*(NAVIGATE|SEARCH)\s*\|\s*(.*?)\]/i);
    if (actionMatch) {
      const type = actionMatch[1].toUpperCase();
      let payload = actionMatch[2].trim();
      
      let url = "";
      if (type === "NAVIGATE") {
        url = payload;
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
        }
        systemMessage = `[System: Yuuna opened ${url}]`;
      } else if (type === "SEARCH") {
        url = `https://www.google.com/search?q=${encodeURIComponent(payload)}`;
        systemMessage = `[System: Yuuna searched for "${payload}" on Google]`;
      }

      if (url) {
        chrome.tabs.create({ url: url });
        port.postMessage({ type: "ACTION", message: systemMessage });
      }
    }

    port.postMessage({ type: "DONE" });
  } catch (error) {
    console.error("Error connecting to backend:", error);
    port.postMessage({ type: "ERROR", message: error.toString() });
  }
}
