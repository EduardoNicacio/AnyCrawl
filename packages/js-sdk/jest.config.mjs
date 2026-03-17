import baseConfig from "../../jest.config.base.mjs";

const config = {
    ...baseConfig,
    setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
    coveragePathIgnorePatterns: ["/node_modules/", "e2e\\.live\\.test\\.ts"],
    coverageThreshold: {
        global: {
            branches: 95,
            functions: 98,
            lines: 99,
            statements: 99,
        },
    },
};

export default config; 