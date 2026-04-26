declare module "puppeteer" {
  const puppeteer: {
    launch(options?: unknown): Promise<{
      newPage(): Promise<{
        setContent(html: string, options?: unknown): Promise<void>;
        emulateMediaType(type: string): Promise<void>;
        pdf(options?: unknown): Promise<Uint8Array | Buffer>;
      }>;
      close(): Promise<void>;
    }>;
  };

  export default puppeteer;
}
