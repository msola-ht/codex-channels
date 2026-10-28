import {
  fastServiceTierId,
  listProviders,
  ultrafastServiceTierId,
  type ModelSelectionState,
} from "../application/index.js";

/** Presentation only: preserve raw identities, source objects and catalogue order. */
export function createModelSelectionPresentation(state: ModelSelectionState) {
  const currentProvider = state.modelProvider ?? "openai";
  const matchesCurrent = (model: ModelSelectionState["models"][number]): boolean =>
    model.model === state.model && (model.provider ?? "openai") === currentProvider;
  // Some existing channel views display a matching but unavailable entry. Keep both meanings explicit.
  const matchingCurrentModel = state.models.find(matchesCurrent);
  const availableCurrentModel = state.models.find(model => model.available !== false && matchesCurrent(model));
  const scopedModels = state.providerFilter === undefined
    ? state.models
    : state.models.filter(model => (model.provider ?? "openai") === state.providerFilter);
  const speedOptions: Array<{ label: string; mode: "off" | "on" | "ultrafast" }> = [
    { label: "Standard", mode: "off" },
    ...(availableCurrentModel && fastServiceTierId(availableCurrentModel)
      ? [{ label: "Fast", mode: "on" as const }] : []),
    ...(availableCurrentModel && ultrafastServiceTierId(availableCurrentModel)
      ? [{ label: "Ultrafast", mode: "ultrafast" as const }] : []),
  ];
  return {
    matchingCurrentModel,
    availableCurrentModel,
    providers: listProviders(state.models).map((id, index) => ({
      id, position: index + 1, isCurrent: id === currentProvider,
    })),
    entries: scopedModels.map((model, index) => ({
      model,
      provider: model.provider ?? "openai",
      position: index + 1,
      isCurrent: matchesCurrent(model),
    })),
    speedOptions,
  };
}
