import { getInboxEndpoint } from "./settings.js";

const VIEWPORT_DATA_URL_PREFIX = "data:image/jpeg;base64,";

export async function sendPageToInbox({ task, page, viewport }) {
  const body = JSON.stringify({
    prompt: requireTask(task),
    page: pageContext(page),
    attachments: viewport ? [createViewportAttachment(viewport)] : undefined,
  });
  const endpoint = await getInboxEndpoint();
  let response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (cause) {
    throw new Error(`Couldn’t reach Agent Teams at ${endpoint}.`, { cause });
  }

  if (response.ok) return;

  const result = await response.json().catch(() => null);
  throw new Error(result?.error ?? `Agent Teams returned ${response.status}.`);
}

export async function captureViewport(windowId) {
  try {
    const dataUrl = await browser.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 82,
    });

    return dataUrl.startsWith(VIEWPORT_DATA_URL_PREFIX) ? dataUrl : undefined;
  } catch {
    // Some pages and windows cannot be captured. The viewport is optional.
    return undefined;
  }
}

function requireTask(task) {
  const normalizedTask = task.trim();
  if (!normalizedTask) throw new Error("A task is required.");
  return normalizedTask;
}

// Agent Teams keeps the page's own words apart from the task, as content the user didn't write.
function pageContext(page) {
  const url = page.url?.trim();
  if (!url) throw new Error("The current page URL is unavailable.");

  const context = { url };
  for (const key of ["title", "selection", "linkUrl", "mediaUrl"]) {
    const value = page[key]?.trim();
    if (value) context[key] = value;
  }
  return context;
}

function createViewportAttachment(dataUrl) {
  if (!dataUrl.startsWith(VIEWPORT_DATA_URL_PREFIX)) {
    throw new Error("The viewport screenshot is invalid.");
  }

  return {
    mimeType: "image/jpeg",
    base64: dataUrl.slice(VIEWPORT_DATA_URL_PREFIX.length),
  };
}
