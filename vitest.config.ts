import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
	new URL("./migrations", import.meta.url).pathname,
);

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					AGENT_EXECUTOR_ENABLED: "false",
					TEST_MIGRATIONS: migrations,
				},
			},
		}),
	],
	test: {
		include: [
			"test/worker.test.ts",
			"test/submit-reviewer.test.ts",
			"test/tool-diagnostic.test.ts",
		],
		setupFiles: ["./test/apply-migrations.ts"],
	},
});
