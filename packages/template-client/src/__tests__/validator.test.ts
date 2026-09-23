import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { TemplateCodeValidator } from "../validator/index.js";
import type { TemplateConfig } from "@anycrawl/libs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("TemplateCodeValidator", () => {
    let validator: TemplateCodeValidator;
    let mockTemplate: TemplateConfig;

    beforeEach(() => {
        validator = new TemplateCodeValidator();

        mockTemplate = {
            uuid: "test-uuid",
            templateId: "test-template",
            name: "Test Template",
            description: "A test template",
            tags: ["test"],
            version: "1.0.0",
            pricing: { perCall: 1, currency: "credits" },
            templateType: "scrape",
            reqOptions: {
                engine: "cheerio",
                formats: ["json"],
            },
            metadata: {
                difficulty: "beginner",
                estimatedTime: 1,
                requiresCustomHandlers: false,
                reviewStatus: "approved",
            },
            createdBy: "test-user",
            status: "published",
            reviewStatus: "approved",
            trusted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
        } as TemplateConfig;
    });

    describe("validateCode", () => {
        it("should validate correct JavaScript code", async () => {
            const validCode = `
                const title = document.querySelector('h1')?.textContent;
                const price = document.querySelector('.price')?.textContent;
                return { title, price };
            `;

            await expect(validator.validateCode(validCode, mockTemplate)).resolves.not.toThrow();
        });

        it("should reject code with syntax errors", async () => {
            const invalidCode = "const invalid = {";

            await expect(validator.validateCode(invalidCode, mockTemplate)).rejects.toThrow("Invalid syntax");
        });

        it("should reject code with eval", async () => {
            const dangerousCode = "eval('alert(1)')";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("eval() is not allowed");
        });

        it("should reject code with Function constructor", async () => {
            const dangerousCode = "new Function('return 1')()";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("Function constructor is not allowed");
        });

        it("should reject code with setTimeout", async () => {
            const dangerousCode = "setTimeout(() => {}, 1000)";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("setTimeout is not allowed");
        });

        it("should reject code with setInterval", async () => {
            const dangerousCode = "setInterval(() => {}, 1000)";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("setInterval is not allowed");
        });

        it("should reject code with process object", async () => {
            const dangerousCode = "process.exit(1)";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("process object is not allowed");
        });

        it("should reject code with require", async () => {
            const dangerousCode = "require('fs')";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("require() is not allowed");
        });

        it("should reject code with import statements", async () => {
            const dangerousCode = "import fs from 'fs'";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("Invalid syntax");
        });

        it("should reject code with fs module", async () => {
            const dangerousCode = "fs.readFileSync('/etc/passwd')";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("fs module is not allowed");
        });

        it("should reject code with child_process", async () => {
            const dangerousCode = "child_process.exec('rm -rf /')";

            await expect(validator.validateCode(dangerousCode, mockTemplate)).rejects.toThrow("Security violation: process object is not allowed");
        });

        it("should reject code that is too long", async () => {
            const longCode = "a".repeat(10001);

            await expect(validator.validateCode(longCode, mockTemplate)).rejects.toThrow("Code too long");
        });

        it("allows reviewed trusted handlers up to 50k characters", async () => {
            const trusted = { ...mockTemplate, trusted: true, reviewStatus: "approved" as const };
            const handler = "return 1;\n" + " ".repeat(36_000);
            await expect(validator.validateCode(handler, trusted)).resolves.toBe(true);
            await expect(validator.validateCode("return 1;\n" + " ".repeat(50_000), {
                ...trusted, updatedAt: new Date(Date.now() + 1000),
            })).rejects.toThrow("Code too long (max 50000 characters)");
        });

        it("validates the published Instagram and YouTube handlers", async () => {
            for (const templateId of ["instagram-scraper", "youtube-video-content-extractor"]) {
                const handler = readFileSync(
                    resolve(process.cwd(), "../../templates", templateId, "requestHandler.js"),
                    "utf8"
                );
                await expect(validator.validateCode(handler, {
                    ...mockTemplate, templateId, trusted: true, reviewStatus: "approved",
                })).resolves.toBe(true);
            }
        });

        it("should reject code with too much nesting", async () => {
            const deeplyNestedCode = "{".repeat(25) + "}".repeat(25);

            await expect(validator.validateCode(deeplyNestedCode, mockTemplate)).rejects.toThrow("Code nesting too deep");
        });

        it("should reject code with too many loops", async () => {
            const loopyCode = Array(12).fill("for(let i=0;i<10;i++){}").join("\n");

            await expect(validator.validateCode(loopyCode, mockTemplate)).rejects.toThrow("Too many loops");
        });

        it("should accept code with reasonable complexity", async () => {
            const reasonableCode = `
                function extractData() {
                    const results = [];
                    for (let i = 0; i < 5; i++) {
                        const element = document.querySelector(\`#item-\${i}\`);
                        if (element) {
                            results.push({
                                title: element.querySelector('.title')?.textContent,
                                price: element.querySelector('.price')?.textContent,
                            });
                        }
                    }
                    return results;
                }
                return extractData();
            `;

            await expect(validator.validateCode(reasonableCode, mockTemplate)).resolves.not.toThrow();
        });
    });
});
