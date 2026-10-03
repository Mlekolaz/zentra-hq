import {
  migrationInvocation,
  runMigrationCommand,
  verifiedMigrationSql,
} from "../apps/api/src/ops/operator-tools.js";

try {
  const sql = await verifiedMigrationSql(process.cwd());
  const invocation = migrationInvocation(process.argv.slice(2), process.env);
  if (invocation === null) {
    console.log(
      "HQ migration checksums/order verified. No database connection or writes.",
    );
  } else {
    await runMigrationCommand(
      invocation.command,
      invocation.args,
      invocation.environment,
      sql,
    );
    console.log("HQ migrations committed in one transaction.");
  }
} catch {
  console.error(
    "HQ migration operation refused or failed. No sensitive diagnostics printed.",
  );
  process.exitCode = 1;
}
