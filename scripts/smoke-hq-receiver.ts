import { sendSmoke } from "../apps/api/src/ops/operator-tools.js";

try {
  const result = await sendSmoke(process.argv.slice(2), process.env);
  console.log(JSON.stringify(result));
} catch {
  console.error(
    "HQ smoke refused or failed. No automatic retry; inspect receiver before any explicit replay.",
  );
  process.exitCode = 1;
}
