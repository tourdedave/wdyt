import { buildArtifactWithOptions } from "./buildArtifact.js";
import { exportPdf, loadSummaryReportData } from "../report/summary-report.js";

export type ArtifactExportFormat = "pdf" | "zip";
type PdfRenderMode = "stub" | "puppeteer";

export const DEFAULT_EXPORT_FILE_NAMES: Record<ArtifactExportFormat, string> = {
  pdf: "wdyt-report.pdf",
  zip: "wdyt-artifact.zip",
};

export async function exportArtifact(options: {
  format: ArtifactExportFormat;
  outputPath?: string;
  pdfMode?: PdfRenderMode;
}) {
  if (options.format === "pdf") {
    const reportData = await loadSummaryReportData();
    return exportPdf(reportData, options.outputPath ?? `./${DEFAULT_EXPORT_FILE_NAMES.pdf}`, {
      mode: options.pdfMode,
    });
  }

  return buildArtifactWithOptions({
    outputPath: options.outputPath ?? `./${DEFAULT_EXPORT_FILE_NAMES.zip}`,
  });
}
