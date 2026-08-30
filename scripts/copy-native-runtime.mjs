import { access, cp, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(
  repositoryRoot,
  "com.jcooler.peripheral-battery.sdPlugin"
);
const sourceModules = join(repositoryRoot, "node_modules");
const targetModules = join(pluginRoot, "node_modules");
const runtimeFiles = {
  "node-hid": [
    "nodehid.js",
    "binding-options.js",
    "package.json",
    "LICENSE-bsd.txt",
    "prebuilds/HID-win32-x64",
    "prebuilds/HID-win32-arm64",
    "prebuilds/HID-darwin-x64",
    "prebuilds/HID-darwin-arm64",
  ],
  "pkg-prebuilds": [
    "bindings.js",
    "package.json",
    "LICENSE",
    "lib",
  ],
};

await mkdir(targetModules, { recursive: true });
for (const [packageName, files] of Object.entries(runtimeFiles)) {
  const source = join(sourceModules, packageName);
  const target = join(targetModules, packageName);
  await assertPackage(source, packageName);
  await mkdir(target, { recursive: true });
  for (const file of files) {
    const destination = join(target, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(source, file), destination, {
      recursive: true,
      force: true,
      filter: copyOnlyChangedFiles,
    });
  }
}

async function copyOnlyChangedFiles(source, destination) {
  const sourceStats = await stat(source);
  if (sourceStats.isDirectory()) return true;
  try {
    const [sourceBytes, destinationBytes] = await Promise.all([
      readFile(source),
      readFile(destination),
    ]);
    return !sourceBytes.equals(destinationBytes);
  } catch {
    return true;
  }
}

await verifyNativeTargets(targetModules);

async function assertPackage(path, packageName) {
  try {
    await access(join(path, "package.json"));
  } catch {
    throw new Error(
      `Missing ${packageName}; run npm ci before building the plugin`
    );
  }
}

async function verifyNativeTargets(modulesRoot) {
  const packageJson = JSON.parse(
    await readFile(join(modulesRoot, "node-hid", "package.json"), "utf8")
  );
  if (packageJson.version !== "3.4.0") {
    throw new Error(`Unexpected node-hid runtime version: ${packageJson.version}`);
  }
  const requiredPrebuilds = [
    ["HID-win32-x64", "node-napi-v4.node"],
    ["HID-win32-arm64", "node-napi-v4.node"],
    ["HID-darwin-x64", "node-napi-v4.node"],
    ["HID-darwin-arm64", "node-napi-v4.node"],
  ];
  for (const segments of requiredPrebuilds) {
    await access(join(modulesRoot, "node-hid", "prebuilds", ...segments));
  }
  await access(join(modulesRoot, "pkg-prebuilds", "bindings.js"));
}
