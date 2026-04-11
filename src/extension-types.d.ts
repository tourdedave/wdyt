declare namespace chrome {
  namespace runtime {
    let lastError:
      | {
          message?: string;
        }
      | undefined;
    function getManifest(): { version: string };
    function getURL(path: string): string;
    function sendMessage(
      message: unknown,
      callback?: (response: unknown) => void
    ): void;
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: { tab?: { id?: number } },
          sendResponse: (response?: unknown) => void
        ) => boolean | void
      ): void;
    };
    const onStartup: { addListener(callback: () => void): void };
    const onInstalled: { addListener(callback: () => void): void };
  }

  namespace tabs {
    function query(
      queryInfo: { active?: boolean; currentWindow?: boolean },
      callback: (tabs: Array<{ id?: number; url?: string }>) => void
    ): void;
    const onRemoved: { addListener(callback: (tabId: number) => void): void };
  }

  namespace scripting {
    function executeScript(
      injection: {
        target: { tabId: number };
        func: () => unknown;
      },
      callback: (results: Array<{ result: unknown }>) => void
    ): void;
  }

  namespace alarms {
    function create(name: string, info: { when: number }): void;
    function clear(name: string): void;
    const onAlarm: {
      addListener(callback: (alarm: { name: string }) => void): void;
    };
  }

  namespace storage {
    namespace local {
      function get(
        keys: string | string[] | Record<string, unknown> | null,
        callback: (items: Record<string, unknown>) => void
      ): void;
      function set(items: Record<string, unknown>, callback?: () => void): void;
    }
  }
}
