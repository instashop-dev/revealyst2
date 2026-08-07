import {
  fetchSuggestions,
  fetchTeams,
  logEvent,
  postFeedback,
  saveToLibrary,
  sha256Hex,
} from "./api.js";

export type ExtensionMessage =
  | {
      type: "GET_SUGGESTIONS";
      flags: string[];
      breakdown?: Record<string, number>;
      promptHash?: string;
      apiBase: string;
    }
  | { type: "LOG_EVENT"; payload: Parameters<typeof logEvent>[1]; apiBase: string }
  | {
      type: "SAVE_LIBRARY";
      payload: Parameters<typeof saveToLibrary>[1];
      token?: string;
      apiBase: string;
    }
  | {
      type: "POST_FEEDBACK";
      suggestionId: string;
      wasAccepted: boolean;
      token: string;
      apiBase: string;
    }
  | { type: "GET_TEAMS"; token: string; apiBase: string }
  | { type: "HASH"; text: string };

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  void (async () => {
    switch (message.type) {
      case "GET_SUGGESTIONS":
        sendResponse(
          await fetchSuggestions(
            message.apiBase,
            message.flags,
            message.breakdown,
            message.promptHash,
          ),
        );
        break;
      case "LOG_EVENT":
        await logEvent(message.apiBase, message.payload);
        sendResponse({ success: true });
        break;
      case "SAVE_LIBRARY":
        sendResponse(await saveToLibrary(message.apiBase, message.payload, message.token));
        break;
      case "POST_FEEDBACK":
        await postFeedback(
          message.apiBase,
          message.token,
          message.suggestionId,
          message.wasAccepted,
        );
        sendResponse({ success: true });
        break;
      case "GET_TEAMS":
        sendResponse(await fetchTeams(message.apiBase, message.token));
        break;
      case "HASH":
        sendResponse(await sha256Hex(message.text));
        break;
      default:
        sendResponse(undefined);
    }
  })().catch((error: unknown) => sendResponse({ error: String(error) }));
  return true; // async response
});

console.log("Revealyst service worker ready");
