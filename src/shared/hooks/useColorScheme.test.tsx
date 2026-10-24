import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemePreferenceContext, useColorScheme, useThemePreference } from "./useColorScheme";

function ThemeSnapshot() {
  return <span>{`${useThemePreference()}:${useColorScheme()}`}</span>;
}

test("SSR consumers start with the root's explicit preference before hydration", () => {
  for (const preference of ["light", "dark"] as const) {
    const html = renderToStaticMarkup(
      <ThemePreferenceContext value={preference}>
        <ThemeSnapshot />
      </ThemePreferenceContext>,
    );
    expect(html).toBe(`<span>${preference}:${preference}</span>`);
  }
});
