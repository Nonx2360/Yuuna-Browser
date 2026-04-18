// content.js
// This script runs in the context of the web page

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_CONTEXT") {
    // Extract simple text content to give Yuuna-chan context
    // We limit the length to avoid overflowing the LLM context limits
    let pageText = document.body.innerText;
    // Basic cleanup: remove extra newlines and spaces
    pageText = pageText.replace(/\s+/g, ' ').trim();
    
    const context = `
      URL: ${window.location.href}
      Title: ${document.title}
      Content Snippet: ${pageText.substring(0, 3000)}
    `;
    
    sendResponse({ context });
  }
  return true;
});
