/* test hook + boot */
window.__app = { App, Store, Pricing, parseClaudeLogs, parseChatGPTExport, parseClaudeAiExport, parseGenericCSV, parseAnthropicUsage, parseOpenAIUsage, sniffJSON };
document.addEventListener('DOMContentLoaded', () => App.init());
