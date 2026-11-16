import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const lock = JSON.parse(
  await fs.readFile(
    new URL("../vendor/protocol-lock.json", import.meta.url),
    "utf8",
  ),
) as { artifact: string; sha256: string };
assert.match(lock.artifact, /^tescord-types-[a-zA-Z0-9.-]+\.tgz$/);
assert.equal(
  createHash("sha256")
    .update(
      await fs.readFile(new URL(`../vendor/${lock.artifact}`, import.meta.url)),
    )
    .digest("hex"),
  lock.sha256,
);
console.log(`PASS shared protocol artifact SHA256 ${lock.sha256}`);
