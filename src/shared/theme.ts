export type ColorScheme = "light" | "dark";
export type ThemePreference = "system" | ColorScheme;

const THEME_COOKIE = "toybox_theme";
const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
let media: MediaQueryList | undefined;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemePreference(cookieHeader?: string | null): ThemePreference {
  const value = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${THEME_COOKIE}=`))
    ?.slice(THEME_COOKIE.length + 1);
  return isThemePreference(value) ? value : "system";
}

export function serializeThemePreference(preference: ThemePreference): string {
  const maxAge = preference === "system" ? 0 : 60 * 60 * 24 * 365;
  return `${THEME_COOKIE}=${preference}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

export function resolveColorScheme(
  preference: ThemePreference,
  systemScheme: ColorScheme,
): ColorScheme {
  return preference === "system" ? systemScheme : preference;
}

export function getThemePreference(): ThemePreference {
  return readThemePreference(typeof document === "undefined" ? undefined : document.cookie);
}

export function getColorScheme(): ColorScheme {
  const systemScheme =
    typeof window !== "undefined" && window.matchMedia(PREFERS_DARK_QUERY).matches
      ? "dark"
      : "light";
  return resolveColorScheme(getThemePreference(), systemScheme);
}

function notifyThemeChange(): void {
  // Update CSS before notifying consumers that read resolved colors.
  document.documentElement.dataset.theme = getThemePreference();
  for (const listener of listeners) listener();
}

export function setThemePreference(preference: ThemePreference): void {
  document.cookie = serializeThemePreference(preference);
  if (getThemePreference() !== preference) {
    throw new Error("Unable to save the theme preference. Enable cookies for Toy Box.");
  }
  notifyThemeChange();
}

export function subscribeTheme(listener: () => void): () => void {
  if (listeners.size === 0) {
    media = window.matchMedia(PREFERS_DARK_QUERY);
    media.addEventListener("change", notifyThemeChange);
    window.addEventListener("focus", notifyThemeChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      media?.removeEventListener("change", notifyThemeChange);
      media = undefined;
      window.removeEventListener("focus", notifyThemeChange);
    }
  };
}
