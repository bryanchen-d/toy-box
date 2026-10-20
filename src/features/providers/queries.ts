import { mutationOptions, queryOptions } from "@tanstack/react-query";
import {
  getProviderCatalog,
  getProviderSubscription,
  getProviderVersions,
  updateProvider,
} from "./server/functions";

export type ProviderUpdateResult = Awaited<ReturnType<typeof updateProvider>>;

export const providerQueries = {
  all: () => ["providers"] as const,

  catalog: () =>
    queryOptions({
      queryKey: providerQueries.all(),
      queryFn: getProviderCatalog,
      staleTime: Infinity,
    }),

  versions: () =>
    queryOptions({
      queryKey: [...providerQueries.all(), "versions"],
      queryFn: getProviderVersions,
    }),

  // Each read asks the provider's CLI, so a subscription refreshes at most once a minute.
  subscription: (providerId: string) =>
    queryOptions({
      queryKey: [...providerQueries.all(), "subscription", providerId],
      queryFn: () => getProviderSubscription({ data: providerId }),
      staleTime: 60_000,
      retry: false,
    }),
};

export const providerMutations = {
  updateKey: () => [...providerQueries.all(), "update"] as const,

  update: () =>
    mutationOptions({
      mutationKey: providerMutations.updateKey(),
      mutationFn: (providerId: string) => updateProvider({ data: providerId }),
      gcTime: 3000,
    }),
};
