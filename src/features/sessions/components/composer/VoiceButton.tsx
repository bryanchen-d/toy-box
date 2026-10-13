import { Loader2, Mic, PhoneOff } from "lucide-react";
import { ComposerAction } from "@/shared/composers/Composer";
import { useVoiceComposer, type VoiceComposerContext } from "./useVoiceComposer";

export function VoiceButton({ context }: { context: VoiceComposerContext }) {
  const { status, connect, disconnect } = useVoiceComposer(context);
  const isConnected = status === "connected";
  const isConnecting = status === "connecting";

  return (
    <ComposerAction
      label={isConnected ? "Stop voice" : "Start voice"}
      variant={isConnected ? "destructive-ghost" : "ghost"}
      aria-pressed={isConnected}
      onClick={() => void (isConnected ? disconnect() : connect())}
      disabled={isConnecting}
    >
      {isConnecting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : isConnected ? (
        <PhoneOff className="h-4 w-4" />
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </ComposerAction>
  );
}
