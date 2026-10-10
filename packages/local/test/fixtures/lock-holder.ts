import { createProcessService } from "../../src/lock.ts";

const lockPath = process.argv[2];
if (lockPath === undefined) throw new Error("Lock path is required.");

await createProcessService().withFileLock(lockPath, async () => {
  process.stdout.write("locked\n");
  await new Promise<never>(() => undefined);
});
