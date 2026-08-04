// Exports every Supabase table to CSV for the daily backup workflow.
// Requires SUPABASE_SERVICE_ROLE_KEY env var (bypasses RLS, full read access).
// Usage: node scripts/backup-export.mjs <output-dir>

const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUTPUT_DIR = process.argv[2];

const TABLES = [
  "category_map",
  "transactions",
  "budget_groups",
  "budget_group_categories",
  "budget_amounts",
  "goals_assumptions",
  "asset_snapshots",
  "payment_methods",
  "account_balances",
  "stock_transactions",
];

if (!SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
  process.exit(1);
}
if (!OUTPUT_DIR) {
  console.error("Usage: node scripts/backup-export.mjs <output-dir>");
  process.exit(1);
}

const { mkdir, writeFile } = await import("node:fs/promises");
await mkdir(OUTPUT_DIR, { recursive: true });

let hadError = false;

for (const table of TABLES) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      Accept: "text/csv",
    },
  });

  if (!res.ok) {
    console.error(`Failed to export ${table}: ${res.status} ${await res.text()}`);
    hadError = true;
    continue;
  }

  const csv = await res.text();
  await writeFile(`${OUTPUT_DIR}/${table}.csv`, csv, "utf8");
  console.log(`Exported ${table}: ${csv.split("\n").length - 1} rows`);
}

if (hadError) process.exit(1);
