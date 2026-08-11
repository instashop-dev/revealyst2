import {
  fetchMe,
  fetchSuggestions,
  fetchTeams,
  logEvent,
  postFeedback,
  requestMagicLink,
  saveToLibrary,
  verifyMagicToken,
} from "./api.js";

export type ExtensionMessage =
  | {
      type: "GET_SUGGESTIONS";
      flags: string[];
      breakdown?: Record<string, number>;
      promptHash?: string;
      apiBase: string;
    }
  | { type: "LOG_EVENT"; payload: Parameters<typeof logEvent>[1]; token?: string; apiBase: string }
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
  | { type: "GET_ME"; token: string; apiBase: string }
  | { type: "REQUEST_MAGIC_LINK"; email: string; apiBase: string }
  | { type: "VERIFY_MAGIC_TOKEN"; token: string; apiBase: string };

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
        await logEvent(message.apiBase, message.payload, message.token);
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
      // Popup connect flows (toolbar action): the popup validates its token
      // against /api/auth/me and exchanges email magic links for a session
      // token. Errors bubble to the catch below as { error, status }.
      case "GET_ME":
        sendResponse({ email: (await fetchMe(message.apiBase, message.token)).email });
        break;
      case "REQUEST_MAGIC_LINK":
        await requestMagicLink(message.apiBase, message.email);
        sendResponse({ ok: true });
        break;
      case "VERIFY_MAGIC_TOKEN":
        sendResponse(await verifyMagicToken(message.apiBase, message.token));
        break;
      default:
        sendResponse(undefined);
    }
  })().catch((error: unknown) =>
    sendResponse({
      error: String(error),
      status:
        typeof (error as { status?: unknown })?.status === "number"
          ? (error as { status: number }).status
          : undefined,
    }),
  );
  return true; // async response
});

console.log("Revealyst service worker ready");
