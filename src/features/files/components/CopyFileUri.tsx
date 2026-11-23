import type { ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { CopyUri } from "@/shared/ui/copy-uri";
import type { WorkspaceFile } from "../model";
import { fileQueries } from "../queries";

/** Copies the `file:` URI that agents read and that opens the file from a Markdown link. */
export function CopyFileUri({
  file,
  ...props
}: Omit<ComponentProps<typeof CopyUri>, "uri"> & { file: WorkspaceFile }) {
  const { data: uri } = useQuery(fileQueries.uri(file));
  return <CopyUri {...props} uri={uri ?? undefined} />;
}
