import {
  type BotApplication,
  type Channel,
  type Message,
} from "@tescord/types";
import type { AccountScheduler } from "../packages/openclaw-channel/src/config.js";
export const token = `nkbot_${"a".repeat(43)}`;
export const application: BotApplication = {
  id: "app1",
  identityId: "bot1",
  userId: "bot1",
  guildId: "guild1",
  ownerId: "owner1",
  managedRoleId: "role1",
  name: "Test",
  defaultContextLimit: 20,
  configVersion: 1,
  device: null,
  channelSettings: [],
  createdAt: new Date().toISOString(),
};
export const channel: Channel = {
  id: "channel1",
  guildId: "guild1",
  name: "test",
  type: "TEXT",
  position: 0,
  createdAt: new Date().toISOString(),
};
export function message(id = "message1", content = "test"): Message {
  return {
    id,
    content,
    channelId: channel.id,
    authorId: "user1",
    author: { id: "user1", username: "User", displayName: "User" },
    createdAt: new Date().toISOString(),
    isEncrypted: false,
    sequence: 20,
  };
}
export function scheduler(): AccountScheduler {
  const abort = new AbortController();
  const children = new Set<AccountScheduler>();
  const handles = new Map<string, { cancel(): void; stop(): Promise<void> }>();
  const running = new Set<Promise<unknown>>();
  const scope: AccountScheduler = {
    version: 1,
    signal: abort.signal,
    now: Date.now,
    scope: () => {
      const child = scheduler();
      children.add(child);
      if (abort.signal.aborted) child.beginClose();
      return child;
    },
    schedule: (options) => {
      if (abort.signal.aborted) throw abort.signal.reason;
      handles.get(options.id)?.cancel();
      let timer: ReturnType<typeof setTimeout>;
      let cancelled = false;
      const handle = {
        cancel: () => {
          cancelled = true;
          clearTimeout(timer);
          if (handles.get(options.id) === handle) handles.delete(options.id);
        },
        stop: async () => {
          handle.cancel();
          await Promise.allSettled([...running]);
        },
      };
      const run = () => {
        if (cancelled || abort.signal.aborted) return;
        const pending = Promise.resolve().then(options.run);
        running.add(pending);
        void pending
          .catch(() => {})
          .finally(() => {
            running.delete(pending);
            if (!cancelled && options.everyMs && !abort.signal.aborted)
              timer = setTimeout(run, options.everyMs);
            else if (handles.get(options.id) === handle)
              handles.delete(options.id);
          });
      };
      timer = setTimeout(
        run,
        "delayMs" in options
          ? options.delayMs
          : Math.max(0, options.atMs - Date.now()),
      );
      handles.set(options.id, handle);
      return handle;
    },
    beginClose: () => {
      abort.abort(new Error("SCHEDULER_CLOSED"));
      for (const handle of handles.values()) handle.cancel();
      for (const child of children) child.beginClose();
    },
    stop: async () => {
      scope.beginClose();
      await Promise.allSettled([
        ...running,
        ...[...children].map((child) => child.stop()),
      ]);
    },
  };
  return scope;
}
