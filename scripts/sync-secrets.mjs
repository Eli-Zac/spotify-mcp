// Prints the Worker secrets found in the environment as JSON for `wrangler secret bulk`.
// Unset or empty values are skipped, so they never overwrite what the Worker already has.
const required = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET", "MCP_AUTH_TOKEN"];
const optional = ["SPOTIFY_REFRESH_TOKEN", "DEFAULT_DEVICE"];

const secrets = {};
for (const name of [...required, ...optional]) {
  const value = (process.env[name] ?? "").trim();
  if (value) secrets[name] = value;
}

for (const name of required) {
  if (!secrets[name]) console.error(`::warning::GitHub secret ${name} is not set, so the Worker keeps its current value (if any).`);
}
if (!secrets.SPOTIFY_REFRESH_TOKEN) {
  console.error("::notice::SPOTIFY_REFRESH_TOKEN is not set yet. Open /setup/<MCP_AUTH_TOKEN> on the Worker to get one, add it as a GitHub secret, then re-run this workflow.");
}
console.error(`Syncing: ${Object.keys(secrets).join(", ") || "(nothing)"}`);

process.stdout.write(JSON.stringify(secrets));
