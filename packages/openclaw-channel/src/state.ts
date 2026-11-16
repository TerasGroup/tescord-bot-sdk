import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChannelError } from "./config.js";
export async function accountDirectory(
  stateRoot: string,
  accountId: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId))
    throw new ChannelError("INVALID_ACCOUNT_ID");
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const canonical = await fs.realpath(stateRoot);
  const parent = path.join(canonical, "nekord");
  for (const entry of [parent, path.join(parent, accountId)]) {
    try {
      await fs.mkdir(entry, { mode: 0o700 });
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
    const info = await fs.lstat(entry);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ChannelError("STATE_PATH_INVALID");
  }
  const directory = path.join(parent, accountId);
  const actual = await fs.realpath(directory);
  const relative = path.relative(canonical, actual);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new ChannelError("STATE_PATH_INVALID");
  await fs.chmod(directory, 0o700);
  return directory;
}
export async function readState(
  file: string,
  maximum = 16 * 1024 * 1024,
): Promise<unknown | undefined> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum)
      throw new ChannelError("STATE_FILE_INVALID");
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return value;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw new ChannelError("STATE_FILE_INVALID");
  }
}
export async function writeState(
  file: string,
  value: unknown,
  createOnly = false,
): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (createOnly) {
      try {
        await fs.link(temporary, file);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
          return false;
        throw error;
      }
    } else await fs.rename(temporary, file);
    return true;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
