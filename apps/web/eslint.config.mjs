import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["src/server/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program > ExpressionStatement[directive='use client']",
          message: "ブラウザ側のコンポーネントはsrc/clientに置いてください。",
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "coverage/**",
    "next-env.d.ts",
    "src/server/infrastructure/sql-connect/generated/**",
  ]),
]);
