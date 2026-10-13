import type { ModelInfo } from "@github/copilot-sdk";
import type { ContextTier, ModelOptionInfo } from "@providers/model";
export type ModelCatalogInfo = ModelInfo & ModelOptionInfo;

/** Adapt SDK models into one entry per ID, decorated with context-window metadata. */
export function adaptModelCatalog(models: readonly ModelCatalogInfo[]): ModelCatalogInfo[] {
  // Some CLI versions list the whole catalog twice; keep each ID's first entry.
  const uniqueModels = models.filter(
    (model, index) => models.findIndex(({ id }) => id === model.id) === index,
  );
  return uniqueModels.map((model) => {
    if (model.supportedContextTiers !== undefined) return model;

    const supportedContextTiers = deriveContextTiers(model);
    if (!supportedContextTiers) return model;

    return {
      ...model,
      supportedContextTiers,
    };
  });
}

/** Billing advertises each tier's prompt allowance; the runtime reports the same context limit. */
function deriveContextTiers(model: ModelCatalogInfo): ContextTier[] | undefined {
  const tokenPrices = model.billing?.tokenPrices;
  const defaultTokens = tokenPrices?.maxPromptTokens;
  const longContextTokens = tokenPrices?.longContext?.maxPromptTokens;
  if (defaultTokens === undefined || longContextTokens === undefined) return undefined;

  return [
    { name: "default", tokenWindow: defaultTokens },
    { name: "long_context", tokenWindow: longContextTokens },
  ];
}
