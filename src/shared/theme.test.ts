import { expect, mock, spyOn, test } from "bun:test";
import {
  getColorScheme,
  getThemePreference,
  isThemePreference,
  readThemePreference,
  resolveColorScheme,
  serializeThemePreference,
  setThemePreference,
  subscribeTheme,
} from "./theme";

test("reads only a valid browser-local theme cookie", () => {
  expect(readThemePreference()).toBe("system");
  expect(readThemePreference("unrelated=dark")).toBe("system");
  expect(readThemePreference("toybox_theme=invalid")).toBe("system");
  expect(readThemePreference("other=1; toybox_theme=dark; more=2")).toBe("dark");
  expect(readThemePreference("toybox_theme=light")).toBe("light");
  expect(isThemePreference(null)).toBe(false);
  expect(isThemePreference("system")).toBe(true);
});

test("persists explicit overrides and removes the cookie for System", () => {
  expect(serializeThemePreference("dark")).toBe(
    "toybox_theme=dark; Path=/; Max-Age=31536000; SameSite=Lax",
  );
  expect(serializeThemePreference("light")).toContain("toybox_theme=light;");
  expect(serializeThemePreference("system")).toContain("Max-Age=0;");
});

test("explicit choices override either system appearance", () => {
  for (const system of ["light", "dark"] as const) {
    expect(resolveColorScheme("system", system)).toBe(system);
    expect(resolveColorScheme("light", system)).toBe("light");
    expect(resolveColorScheme("dark", system)).toBe("dark");
  }
});

test("publishes resolved CSS before notifying subscribers and releases shared listeners", () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const media = Object.assign(new EventTarget(), { matches: false });
  const view = Object.assign(new EventTarget(), { matchMedia: mock(() => media) });
  const removeMediaListener = spyOn(media, "removeEventListener");
  const removeFocusListener = spyOn(view, "removeEventListener");
  const dataset = { theme: "system" };
  let cookie = "";
  let allowCookies = true;
  const document = {
    documentElement: { dataset },
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      if (allowCookies) cookie = value.includes("Max-Age=0") ? "" : value.split(";")[0];
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: view });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });

  const first = mock(() => expect(dataset.theme).toBe(getThemePreference()));
  const second = mock(() => expect(dataset.theme).toBe(getThemePreference()));
  const stopFirst = subscribeTheme(first);
  const stopSecond = subscribeTheme(second);
  try {
    expect(view.matchMedia).toHaveBeenCalledTimes(1);
    setThemePreference("dark");
    expect(getColorScheme()).toBe("dark");
    expect(dataset.theme).toBe("dark");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    expect(removeMediaListener).not.toHaveBeenCalled();
    setThemePreference("system");
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(getColorScheme()).toBe("dark");
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    expect(getColorScheme()).toBe("light");
    expect(first).toHaveBeenCalledTimes(1);

    cookie = "toybox_theme=light";
    view.dispatchEvent(new Event("focus"));
    expect(dataset.theme).toBe("light");
    allowCookies = false;
    expect(() => setThemePreference("dark")).toThrow("Unable to save the theme preference");
  } finally {
    stopFirst();
    stopSecond();
    expect(removeMediaListener).toHaveBeenCalledTimes(1);
    expect(removeFocusListener).toHaveBeenCalledTimes(1);
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
