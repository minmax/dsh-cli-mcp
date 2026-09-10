// Vitest global setup: build the fake-dsh binary before any tests run.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export default function setup(): void {
  const binPath = resolve(process.cwd(), "dist-test/fake-dsh-cli.js");
  if (existsSync(binPath)) return;
  execSync("npm run build:tests", { stdio: "inherit", cwd: process.cwd() });
}
