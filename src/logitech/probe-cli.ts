import { runDirectLogitechProbe } from "./hidpp-source";

const result = await runDirectLogitechProbe();
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.statusKind !== "percentage") process.exitCode = 2;
