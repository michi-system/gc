(function () {
  "use strict";

  const READY_ATTR = "data-gc-zen-bridge";
  const VERSION_ATTR = "data-gc-zen-bridge-version";
  const BRIDGE_VERSION = "0.1.1";

  function markReady() {
    document.documentElement.setAttribute(READY_ATTR, "ready");
    document.documentElement.setAttribute(VERSION_ATTR, BRIDGE_VERSION);
    document.dispatchEvent(new CustomEvent("gc-greenfield-zen-ready", {
      detail: { version: BRIDGE_VERSION },
    }));
  }

  function respond(type, requestId, extra) {
    window.postMessage({
      source: "gc-greenfield-extension",
      type,
      requestId,
      ...extra,
    }, "*");
  }

  function dispatchBridgeEvent(type, requestId, extra) {
    document.dispatchEvent(new CustomEvent(type, {
      detail: {
        requestId,
        ...extra,
      },
    }));
  }

  async function startTask(task, requestId) {
    try {
      await browser.runtime.sendMessage({
        type: "GC_AUTOFILL_RUN",
        task,
      });
      respond("AUTOFILL_EXTENSION_STARTED", requestId);
      dispatchBridgeEvent("gc-greenfield-zen-started", requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Zen extension error";
      respond("AUTOFILL_EXTENSION_ERROR", requestId, {
        error: message,
      });
      dispatchBridgeEvent("gc-greenfield-zen-error", requestId, {
        error: message,
      });
    }
  }

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (!message || message.source !== "gc-greenfield-page") return;

    if (message.type === "AUTOFILL_EXTENSION_PING") {
      markReady();
      respond("AUTOFILL_EXTENSION_READY", message.requestId);
      return;
    }

    if (message.type === "AUTOFILL_EXTENSION_RUN") {
      await startTask(message.task, message.requestId);
    }
  });

  document.addEventListener("gc-greenfield-zen-ping", () => {
    markReady();
  });

  document.addEventListener("gc-greenfield-zen-run", async (event) => {
    const detail = event.detail || {};
    if (!detail.task || !detail.requestId) {
      return;
    }
    await startTask(detail.task, detail.requestId);
  });

  markReady();
})();
