// Typed runtime message contracts shared between popup/content/background.
// Keep this surface narrow and additive to avoid cross-context drift.

export const UI_PATCH_PORT_NAME = "forgeos.ui.patch.v1";

export type UiPatch =
  | {
      type: "network";
      network: string;
      updatedAt: number;
    };

export interface UiPatchEnvelope {
  type: "FORGEOS_UI_PATCH";
  patches: UiPatch[];
}

export function isUiPatchEnvelope(value: unknown): value is UiPatchEnvelope {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.type === "FORGEOS_UI_PATCH" && Array.isArray(data.patches);
}
