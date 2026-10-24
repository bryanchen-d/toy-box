import { createContext, useContext, useSyncExternalStore } from "react";
import {
  getColorScheme,
  getThemePreference,
  resolveColorScheme,
  subscribeTheme,
  type ColorScheme,
  type ThemePreference,
} from "@/shared/theme";

export const ThemePreferenceContext = createContext<ThemePreference>("system");

export function useColorScheme(): ColorScheme {
  const initial = useContext(ThemePreferenceContext);
  return useSyncExternalStore(subscribeTheme, getColorScheme, () =>
    resolveColorScheme(initial, "light"),
  );
}

export function useThemePreference(initialPreference?: ThemePreference): ThemePreference {
  const initial = useContext(ThemePreferenceContext);
  return useSyncExternalStore(
    subscribeTheme,
    getThemePreference,
    () => initialPreference ?? initial,
  );
}
