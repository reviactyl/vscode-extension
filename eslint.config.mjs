import typescriptEslint from "typescript-eslint";

export default [{
    files: ["**/*.ts"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],

        "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
        "@typescript-eslint/no-explicit-any": "error",
        curly: ["error", "multi-line"],
        eqeqeq: "error",
        "no-throw-literal": "error",
        semi: "error",
    },
}];
