// Writes the Hands-off permission rules the person said yes to into the repository's .claude/settings.local.json
// (item 95, slice 4b): node "${CLAUDE_PLUGIN_ROOT}/hooks/allow-permissions.mjs" --root <root> --rule <r>… [--gitignore].
// Prints JSON of what it added; on a refusal it writes nothing, says why on stderr and exits 1.
import { allowPermissions } from "./lib.mjs";

const options = { rules: [], gitignore: false };
let result;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length && !result; i++) {
  if (argv[i] === "--root" && argv[i + 1] !== undefined) options.root = argv[++i];
  else if (argv[i] === "--rule" && argv[i + 1] !== undefined) options.rules.push(argv[++i]);
  else if (argv[i] === "--gitignore") options.gitignore = true;
  else result = { ok: false, message: `unknown argument ${argv[i]}; nothing written` };
}
try {
  result ??= allowPermissions(options);
} catch (e) {
  result = { ok: false, message: `${e.message}; nothing written` };
}
if (result.ok) process.stdout.write(JSON.stringify(result.added) + "\n");
else {
  process.stderr.write(`allow-permissions: ${result.message}\n`);
  process.exitCode = 1;
}
