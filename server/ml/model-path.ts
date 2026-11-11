import path from "node:path";
import { fileURLToPath } from "node:url";

/** The model version this backend release ships with (committed under ml/artifacts/). */
export const DEFAULT_MODEL_VERSION = "scamshield-text-v1.0.0";

export const DEFAULT_MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ml/artifacts", DEFAULT_MODEL_VERSION);
