import { unlink } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import resolveModules from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { rollup } from "rollup";

if (process.argv.length !== 2) {
  process.stderr.write("This probe accepts no hardware or protocol arguments.\n");
  process.exitCode = 64;
} else {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryBundle = join(
    repoRoot,
    "scripts",
    `.probe-logitech-hidpp.${process.pid}.mjs`
  );
  let bundle;
  try {
    bundle = await rollup({
      input: join(repoRoot, "src", "logitech", "probe-cli.ts"),
      external: [
        ...builtinModules,
        ...builtinModules.map((moduleName) => `node:${moduleName}`),
        "node-hid",
      ],
      plugins: [
        resolveModules({ exportConditions: ["node"], preferBuiltins: true }),
        commonjs(),
        json(),
        typescript({
          tsconfig: join(repoRoot, "tsconfig.json"),
          outDir: join(repoRoot, "scripts"),
          sourceMap: false,
        }),
      ],
    });
    await bundle.write({
      file: temporaryBundle,
      format: "esm",
      inlineDynamicImports: true,
    });
    await import(`${pathToFileURL(temporaryBundle).href}?run=${Date.now()}`);
  } finally {
    await bundle?.close();
    await unlink(temporaryBundle).catch(() => undefined);
  }
}
