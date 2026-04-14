import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import json from "@rollup/plugin-json";
import { builtinModules } from "node:module";

export default {
  input: "src/plugin.ts",
  output: {
    file: "com.jcooler.peripheral-battery.sdPlugin/bin/plugin.js",
    format: "esm",
    sourcemap: true,
    inlineDynamicImports: true,
  },
  external: [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  plugins: [
    resolve({
      exportConditions: ["node"],
      preferBuiltins: true,
    }),
    commonjs(),
    json(),
    typescript({
      tsconfig: "./tsconfig.json",
      mapRoot: ".",
    }),
  ],
};
