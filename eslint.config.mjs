import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  globalIgnores([
    "out/**",
    "release/**",
    "build/**",
    ".venv/**",
    "media_service/.venv-*/**",
    "media_service/data/**",
    "media_service/build/**",
    "media_service/dist/**",
    "media_service/**/__pycache__/**",
  ]),
]);

export default eslintConfig;
