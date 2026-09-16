// One file, both APIs: V1 calls server(), V2 reads id/setup(). Each runtime runs one half
// and ignores the other. No `Plugin.define` import, so the bundle stays dependency-free.
import { Armor1Plugin } from "./v1.ts"
import { createV2Setup } from "./v2.ts"

export { Armor1Plugin } from "./v1.ts"
export { createV2Setup } from "./v2.ts"

export default {
  id: "armor1",
  setup: createV2Setup(),
  server: Armor1Plugin,
}
