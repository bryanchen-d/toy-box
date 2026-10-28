import { createContext, useContext } from "react";
import type { DiffStats } from "@/shared/diffStats";

const EditDiffsContext = createContext<Map<string, DiffStats> | null>(null);
export const EditDiffsProvider = EditDiffsContext.Provider;

export function useToolCallDiff(toolCallId: string): DiffStats | undefined {
  return useContext(EditDiffsContext)?.get(toolCallId);
}
