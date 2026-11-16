# Za by Zack ERP

Responsive restaurant ERP coursework demo for sales, inventory, purchasing, production, MRP, and reporting.

## Put these files in GitHub

1. Download and unzip this project.
2. Open the `TimWoodss4ever/ZabyZach` repository on GitHub.
3. Choose **Add file → Upload files**.
4. Upload the contents of this folder (including the `.github` folder), then commit to `main`.
5. Open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
6. Open the **Actions** tab and wait for **Deploy ERP to GitHub Pages** to finish. The site URL will be `https://timwoodss4ever.github.io/ZabyZach/`.

The workflow builds the Vite application and publishes the `dist` folder. The Vite base path is already set for the `ZabyZach` repository name.

## Run locally

```sh
npm install
npm run dev
```

## Current data behavior

The demo seeds sales and inventory activity on first load and stores changes in that browser's local storage. Data does not sync to other devices or browsers. The SQL migrations in `supabase/migrations/` are database setup material; the current frontend does not yet read or write Supabase. Do not put a Supabase service-role key in this public repository.

## Inventory requirement implementation

See [Inventory management changes](INVENTORY_MANAGEMENT.md) for backorders, item/location availability estimates, validated transfers/counts, the database rollout, and verification scenarios. The new inventory features use shared Supabase records; GitHub Pages deployment alone does not install their database migration.
