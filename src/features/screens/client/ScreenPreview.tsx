import { useScreen } from "./useScreen";

/** A passive connection for the hover preview's mounted lifetime. */
export function ScreenPreview({ screenId }: { screenId: string }) {
  const { canvasRef, status, reason } = useScreen(screenId, true);
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-muted/40">
      <canvas
        ref={canvasRef}
        aria-label="Screen preview"
        className="pointer-events-none h-full w-full object-contain"
      />
      {status !== "live" && (
        <p className="absolute inset-0 flex items-center justify-center bg-background/90 p-2 text-center text-xs text-muted-foreground">
          {status === "connecting" ? "Connecting…" : (reason ?? "This screen is unavailable.")}
        </p>
      )}
    </div>
  );
}
