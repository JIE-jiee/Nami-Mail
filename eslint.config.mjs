import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-check*/**",
      "**/build/**",
      "**/release-artifacts/**",
      "**/output/**",
      "**/artifacts/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "apps/web/src/locales/*.generated.ts",
      "apps/desktop/src/native-locale-catalog.generated.mts",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "require-yield": "off",
      "no-unsafe-finally": "off",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
      },
    },
    rules: {
      "no-undef": "off",
      "no-control-regex": "off",
      "no-useless-escape": "warn",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.ts", "e2e/**/*.ts", "apps/server/**/*.ts", "apps/desktop/**/*.ts", "packages/**/*.ts"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-undef": "off",
      "no-control-regex": "off",
    },
  },

  // ---------------------------------------------------------------------------
  // 分层卡口（防回弹）：路由层不得直接执行 SQL。
  //
  // 存量 39 处（messages 17 / accounts 15 / avatars 5 / filter-rules 2）已全部
  // 迁入领域模块，因此规则现在是 error：任何新的路由内 SQL 都会让 lint 失败。
  // ---------------------------------------------------------------------------
  {
    files: ["apps/server/src/routes/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name=/^(prepare|transaction|exec|run)$/]",
          message: "路由层不得直接执行 SQL；请把查询搬进领域函数后调用。",
        },
      ],
    },
  },

  // 巨型文件冻结：只允许瘦身，不允许继续增长（阈值为当前行数 + 少量余量）。
  {
    files: ["apps/web/src/App.tsx"],
    rules: { "max-lines": ["error", { max: 4450, skipBlankLines: false, skipComments: false }] },
  },
  {
    files: ["apps/server/src/agent-service.ts"],
    rules: { "max-lines": ["error", { max: 2890, skipBlankLines: false, skipComments: false }] },
  },
  {
    files: ["apps/desktop/src/main.mts"],
    rules: { "max-lines": ["error", { max: 2120, skipBlankLines: false, skipComments: false }] },
  },
  {
    // 反思轮发现：把代码搬进未冻结的文件即可绕过上述棘轮（App.tsx 的反弹路径）。
    // 补齐剩余巨型 TS 文件。styles.css 无法由 eslint 解析，其棘轮见
    // apps/web/src/styles-size.test.ts（与 designTokens.test.ts 同一读取模式）。
    files: ["apps/web/src/AgentWorkspace.tsx"],
    rules: { "max-lines": ["error", { max: 2460, skipBlankLines: false, skipComments: false }] },
  },
);
