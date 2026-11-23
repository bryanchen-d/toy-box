// Validated workspace-file operations consumed by Query and matching external ingress.

import { createServerFn } from "@tanstack/react-start";
import { zodValidator } from "@tanstack/zod-adapter";
import {
  createFileInputSchema,
  fileLinkInputSchema,
  listDirectoryInputSchema,
  searchFilesInputSchema,
  workspaceFileInputSchema,
  writeFileInputSchema,
} from "../model";
import * as files from "./index";
import { workspaceFileFromLink, workspaceFileUri } from "./paths";

export const readFile = createServerFn({ method: "GET" })
  .validator(zodValidator(workspaceFileInputSchema))
  .handler(({ data }) => files.readFile(data.file));

export const writeFile = createServerFn({ method: "POST" })
  .validator(zodValidator(writeFileInputSchema))
  .handler(({ data }) => files.writeFile(data.file, data.content));

export const createFile = createServerFn({ method: "POST" })
  .validator(zodValidator(createFileInputSchema))
  .handler(({ data }) => files.createFile(data));

export const listDirectory = createServerFn({ method: "GET" })
  .validator(zodValidator(listDirectoryInputSchema))
  .handler(({ data }) => files.listDirectory(data));

export const searchFiles = createServerFn({ method: "GET" })
  .validator(zodValidator(searchFilesInputSchema))
  .handler(({ data }) => files.searchFiles(data));

export const getFileUri = createServerFn({ method: "GET" })
  .validator(zodValidator(workspaceFileInputSchema))
  .handler(({ data }) => workspaceFileUri(data.file));

export const resolveFileLink = createServerFn({ method: "GET" })
  .validator(zodValidator(fileLinkInputSchema))
  .handler(({ data }) => workspaceFileFromLink(data.file, data.href));
