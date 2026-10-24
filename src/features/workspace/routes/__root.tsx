import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import type { CSSProperties, ReactNode } from "react";
import { domMax, LazyMotion, MotionConfig } from "motion/react";
import { useWorkspaceSelector } from "@workspace/hooks/state";
import { workspaceQueries } from "@workspace/queries";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { ThemePreferenceContext, useThemePreference } from "@/shared/hooks/useColorScheme";
import { readThemePreference } from "@/shared/theme";

import appCss from "./styles.css?url";

const APP_TITLE = import.meta.env.VITE_APP_TITLE;

const readWorkspaceRevision = createIsomorphicFn().server(async () => {
  const { getWorkspaceRevision } = await import("@workspace/server/events");
  return getWorkspaceRevision();
});

const readThemeCookie = createIsomorphicFn()
  .client(() => document.cookie)
  .server(async () => {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    return getRequestHeader("cookie");
  });

type RouterContext = {
  queryClient: QueryClient;
};

// Loading indicator shown during route transitions
function RouteLoadingIndicator() {
  return (
    <div className="fixed top-0 left-0 right-0 z-50">
      <div className="h-1 bg-primary animate-pulse" />
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Capture before any route loader reads the snapshots sent through SSR.
  beforeLoad: async () => ({ workspaceRevision: await readWorkspaceRevision() }),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(workspaceQueries.state());
    return { themePreference: readThemePreference(await readThemeCookie()) };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
      },
      { title: APP_TITLE },
      // PWA meta tags for iOS
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: APP_TITLE },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.json" },
      { rel: "apple-touch-icon", href: "/icon-192.png" },
    ],
  }),

  component: Outlet,
  pendingComponent: RouteLoadingIndicator,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: ReactNode }) {
  const initial = Route.useLoaderData();
  const themePreference = useThemePreference(initial.themePreference);
  const accentColor = useWorkspaceSelector((workspace) => workspace.settings.accentColor);
  const style: CSSProperties & { "--accent": string } = {
    "--accent": accentColor,
  };

  // Motion+ uses full motion elements, which are incompatible with LazyMotion strict mode.
  return (
    <html lang="en" style={style} data-theme={themePreference}>
      <head>
        <HeadContent />
      </head>
      <body className="h-dvh overflow-hidden bg-background safe-top safe-x">
        <ThemePreferenceContext value={themePreference}>
          <TooltipProvider>
            <LazyMotion features={domMax}>
              <MotionConfig reducedMotion="user">
                <div className="h-full overflow-hidden">{children}</div>
              </MotionConfig>
            </LazyMotion>
          </TooltipProvider>
        </ThemePreferenceContext>
        <Scripts />
      </body>
    </html>
  );
}
