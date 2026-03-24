import { ModelRegistry } from "./packages/coding-agent/src/core/model-registry.js";
import { AuthStorage } from "./packages/coding-agent/src/core/auth-storage.js";
import { resolveCliModel } from "./packages/coding-agent/src/core/model-resolver.js";

async function main() {
    const auth = AuthStorage.create();
    const modelRegistry = new ModelRegistry(auth);
    const result = resolveCliModel({ cliModel: "local", modelRegistry });
    console.log(result);
}
main().catch(console.error);
