import { tool } from "@langchain/core/tools";
import { GraphState, GraphConfig } from "@openswe/shared/open-swe/types";
import { createLogger, LogLevel } from "../utils/logger.js";
import { getRepoAbsolutePath } from "@openswe/shared/git";
import {
  isLocalMode,
  getLocalWorkingDirectory,
} from "@openswe/shared/open-swe/local-mode";
import { TIMEOUT_SEC } from "@openswe/shared/constants";
import { createShellExecutor } from "../utils/shell-executor/index.js";
import { z } from "zod";

const logger = createLogger(LogLevel.INFO, "PlaywrightTool");

const PlaywrightToolSchema = z.object({
  command: z.enum([
    "run_tests",
    "run_test_file", 
    "install",
    "init",
    "codegen",
    "show_report",
    "check_config"
  ]).describe("The Playwright command to execute"),
  test_file: z.string().optional().describe("Specific test file to run (for run_test_file command)"),
  options: z.string().optional().describe("Additional command line options"),
  browser: z.enum(["chromium", "firefox", "webkit", "all"]).optional().describe("Browser to use for tests"),
  headless: z.boolean().optional().default(true).describe("Run tests in headless mode"),
  ui_mode: z.boolean().optional().default(false).describe("Run tests in UI mode"),
  debug: z.boolean().optional().default(false).describe("Run tests in debug mode"),
});

export function createPlaywrightTool(
  state: Pick<GraphState, "sandboxSessionId" | "targetRepository">,
  config: GraphConfig,
) {
  const playwrightTool = tool(
    async (input): Promise<{ result: string; status: "success" | "error" }> => {
      try {
        const {
          command,
          test_file,
          options,
          browser,
          headless = true,
          ui_mode = false,
          debug = false,
        } = input;

        const localMode = isLocalMode(config);
        const workDir = localMode 
          ? getLocalWorkingDirectory() 
          : getRepoAbsolutePath(state.targetRepository);

        let playwrightCommand: string;

        switch (command) {
          case "run_tests":
            playwrightCommand = "npx playwright test";
            if (browser && browser !== "all") {
              playwrightCommand += ` --project=${browser}`;
            }
            if (!headless) {
              playwrightCommand += " --headed";
            }
            if (ui_mode) {
              playwrightCommand += " --ui";
            }
            if (debug) {
              playwrightCommand += " --debug";
            }
            if (options) {
              playwrightCommand += ` ${options}`;
            }
            break;

          case "run_test_file":
            if (!test_file) {
              throw new Error("test_file is required for run_test_file command");
            }
            playwrightCommand = `npx playwright test ${test_file}`;
            if (browser && browser !== "all") {
              playwrightCommand += ` --project=${browser}`;
            }
            if (!headless) {
              playwrightCommand += " --headed";
            }
            if (debug) {
              playwrightCommand += " --debug";
            }
            if (options) {
              playwrightCommand += ` ${options}`;
            }
            break;

          case "install":
            playwrightCommand = "npx playwright install";
            if (browser && browser !== "all") {
              playwrightCommand += ` ${browser}`;
            }
            break;

          case "init":
            playwrightCommand = "npx playwright install --with-deps";
            break;

          case "codegen":
            playwrightCommand = "npx playwright codegen";
            if (options) {
              playwrightCommand += ` ${options}`;
            }
            break;

          case "show_report":
            playwrightCommand = "npx playwright show-report";
            break;

          case "check_config":
            playwrightCommand = "npx playwright --version && ls -la playwright.config.*";
            break;

          default:
            throw new Error(`Unknown Playwright command: ${command}`);
        }

        logger.info("Executing Playwright command", {
          command: playwrightCommand,
          workDir,
          localMode,
        });

        const executor = createShellExecutor(config);
        const response = await executor.executeCommand({
          command: playwrightCommand,
          workdir: workDir,
          timeout: TIMEOUT_SEC * 3, // Playwright tests can take longer
          env: {
            // Playwright-specific environment variables
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: ui_mode ? "0" : "1",
            CI: "true", // Helps with consistent test behavior
            FORCE_COLOR: "0", // Disable colors for cleaner output
          },
        });

        // Playwright tests can have non-zero exit codes for test failures, but still provide useful output
        if (response.exitCode !== 0 && command === "run_tests" || command === "run_test_file") {
          // For test commands, treat as success even with failures, but include the exit code in the result
          const result = response.result || response.artifacts?.stdout || "";
          return {
            result: `Tests completed with exit code ${response.exitCode}:\n${result}`,
            status: "success",
          };
        } else if (response.exitCode !== 0) {
          // For non-test commands, treat non-zero exit as error
          const errorResult = response.result ?? response.artifacts?.stdout;
          throw new Error(
            `Playwright command failed. Exit code: ${response.exitCode}\nResult: ${errorResult}`,
          );
        }

        return {
          result: response.result ?? `Playwright command completed successfully. Exit code: ${response.exitCode}`,
          status: "success",
        };
      } catch (error: any) {
        logger.error("Playwright tool error", { error: error.message });
        return {
          result: `Error executing Playwright command: ${error.message || String(error)}`,
          status: "error",
        };
      }
    },
    {
      name: "playwright",
      description: `Execute Playwright commands for end-to-end testing. Supports running tests, installing browsers, generating test code, and managing test configurations.
      
Available commands:
- run_tests: Run all Playwright tests
- run_test_file: Run a specific test file  
- install: Install Playwright browsers
- init: Initialize Playwright with dependencies
- codegen: Generate test code using Playwright's codegen tool
- show_report: Show test report
- check_config: Check Playwright configuration and version

Options:
- browser: Choose specific browser (chromium, firefox, webkit, all)
- headless: Run in headless mode (default: true)
- ui_mode: Run in UI mode for interactive testing
- debug: Run in debug mode
- options: Additional command line options`,
      schema: PlaywrightToolSchema,
    },
  );

  return playwrightTool;
}
