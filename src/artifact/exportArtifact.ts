import { buildArtifactWithOptions } from "./buildArtifact.js";

export type ArtifactExportFormat = "zip";

export const DEFAULT_EXPORT_FILE_NAMES: Record<ArtifactExportFormat, string> = {
  zip: "wdyt-artifact.zip",
};

export async function exportArtifact(options: {
  format: ArtifactExportFormat;
  outputPath?: string;
}) {
  return buildArtifactWithOptions({
    outputPath: options.outputPath ?? `./${DEFAULT_EXPORT_FILE_NAMES.zip}`,
  });
}
