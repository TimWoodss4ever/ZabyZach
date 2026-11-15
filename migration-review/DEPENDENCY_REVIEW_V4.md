# Vite security update review

Only the direct Vite development dependency changes, from 8.0.13 to exactly 8.3.8. All other direct dependency versions and npm scripts remain unchanged.

The lockfile changes 23 package records, all inside Vite's old/new dependency trees. Changed or added records are development-only dependencies with npm registry URLs and SHA-512 integrity values. Package metadata is unchanged apart from the root Vite version.

The protected-hashes check now expects these two reviewed package files. The other 13 protected files retain their original hashes. Original authentication, POS, returns, reporting and database loaders remain protected by source checks.

No database SQL, deployment workflow, connection code or environment settings are changed. GitHub must run a fresh dependency install, build and automated checks after upload. The earlier successful preview used Vite 8.3.8, but this new lockfile still needs the GitHub clean-install check. Purchasing and supplier scorecards remain browser-local; this update does not integrate them into Supabase.
